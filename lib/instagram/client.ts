import type {
  InstagramComment,
  InstagramDataset,
  InstagramMetrics,
  InstagramPost,
  InstagramProfile,
} from "./types";

type GraphPage<T> = {
  data?: T[];
  paging?: { next?: string };
};

type GraphProfile = {
  id?: string;
  user_id?: string;
  username?: string;
  account_type?: string;
  followers_count?: number;
  media_count?: number;
};

type GraphMedia = {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  media_url?: string;
  thumbnail_url?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
  children?: {
    data?: GraphMediaChild[];
  };
};

type GraphMediaChild = {
  id: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
};

type GraphComment = {
  id: string;
  text?: string;
  timestamp?: string;
  like_count?: number;
};

type GraphInsight = {
  name: string;
  values?: Array<{ value?: number }>;
  total_value?: { value?: number };
};

type InstagramClientOptions = {
  postLimit: number;
  commentsPerPost: number;
};

export class InstagramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly apiType?: string,
  ) {
    super(message);
    this.name = "InstagramApiError";
  }
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function graphConfig() {
  return {
    accessToken: requiredEnv("INSTAGRAM_ACCESS_TOKEN"),
    version: process.env.INSTAGRAM_API_VERSION?.trim() || "v23.0",
  };
}

async function graphGet<T>(pathOrUrl: string, params: Record<string, string> = {}) {
  const { accessToken, version } = graphConfig();
  const url = pathOrUrl.startsWith("https://")
    ? new URL(pathOrUrl)
    : new URL(`https://graph.instagram.com/${version}/${pathOrUrl.replace(/^\//, "")}`);

  if (url.hostname !== "graph.instagram.com") {
    throw new Error("Instagram pagination returned an unexpected host.");
  }

  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
    signal: AbortSignal.timeout(25_000),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const apiError = payload?.error;
    throw new InstagramApiError(
      apiError?.message || `Instagram API request failed with ${response.status}.`,
      response.status,
      apiError?.code,
      apiError?.type,
    );
  }

  return payload as T;
}

async function graphPage<T>(
  path: string,
  params: Record<string, string>,
  maxItems: number,
) {
  const items: T[] = [];
  let nextUrl: string | undefined;

  do {
    const page = await graphGet<GraphPage<T>>(nextUrl || path, nextUrl ? {} : params);
    items.push(...(page.data || []));
    nextUrl = page.paging?.next;
  } while (nextUrl && items.length < maxItems);

  return items.slice(0, maxItems);
}

function insightValue(insight: GraphInsight) {
  const value = insight.total_value?.value ?? insight.values?.[0]?.value;
  return typeof value === "number" ? value : null;
}

function normalizeInsights(data: GraphInsight[]) {
  const values = new Map(data.map((item) => [item.name, insightValue(item)]));
  return {
    reach: values.get("reach") ?? null,
    saved: values.get("saved") ?? null,
    shares: values.get("shares") ?? null,
    totalInteractions: values.get("total_interactions") ?? null,
    views: values.get("views") ?? null,
  };
}

async function getProfile(): Promise<InstagramProfile> {
  const profile = await graphGet<GraphProfile>("me", {
    fields: "id,user_id,username,account_type,followers_count,media_count",
  });
  const id = profile.user_id || profile.id;
  if (!id) throw new Error("Instagram /me response did not contain a user ID.");

  return {
    id,
    username: profile.username || "unknown",
    accountType: profile.account_type || "PROFESSIONAL",
    followersCount: profile.followers_count ?? null,
    mediaCount: profile.media_count ?? null,
  };
}

async function getMedia(userId: string, limit: number) {
  return graphPage<GraphMedia>(
    `${userId}/media`,
    {
      fields: [
        "id",
        "caption",
        "media_type",
        "media_product_type",
        "permalink",
        "media_url",
        "thumbnail_url",
        "timestamp",
        "like_count",
        "comments_count",
        "children{id,media_type,media_url,thumbnail_url}",
      ].join(","),
      limit: String(Math.min(limit, 50)),
    },
    limit,
  );
}

async function getComments(mediaId: string, limit: number): Promise<InstagramComment[]> {
  if (limit === 0) return [];
  const comments = await graphPage<GraphComment>(
    `${mediaId}/comments`,
    {
      fields: "id,text,timestamp,like_count,from",
      limit: String(Math.min(limit, 50)),
    },
    limit,
  );

  return comments.map((comment) => ({
    id: comment.id,
    text: (comment.text || "").slice(0, 500),
    timestamp: comment.timestamp || null,
    likeCount: comment.like_count || 0,
  }));
}

async function getInsights(mediaId: string) {
  const response = await graphGet<GraphPage<GraphInsight>>(`${mediaId}/insights`, {
    metric: "reach,saved,shares,total_interactions,views",
  });
  return normalizeInsights(response.data || []);
}

async function concurrentMap<T, R>(
  values: T[],
  concurrency: number,
  task: (value: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let cursor = 0;

  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await task(values[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

export async function collectInstagramData(
  options: InstagramClientOptions,
): Promise<InstagramDataset> {
  const warnings: string[] = [];
  const profile = await getProfile();
  const media = await getMedia(profile.id, options.postLimit);

  const posts = await concurrentMap(media, 3, async (item): Promise<InstagramPost> => {
    const [commentsResult, insightsResult] = await Promise.allSettled([
      getComments(item.id, options.commentsPerPost),
      getInsights(item.id),
    ]);

    if (commentsResult.status === "rejected") {
      warnings.push(`Comments could not be loaded for post ${item.id}.`);
    }
    if (insightsResult.status === "rejected") {
      warnings.push(`Insights could not be loaded for post ${item.id}.`);
    }

    const insightMetrics =
      insightsResult.status === "fulfilled"
        ? insightsResult.value
        : {
            reach: null,
            saved: null,
            shares: null,
            totalInteractions: null,
            views: null,
          };

    const metrics: InstagramMetrics = {
      likes: item.like_count || 0,
      comments: item.comments_count || 0,
      ...insightMetrics,
    };
    const childSlides = item.children?.data || [];
    const slides = childSlides.length
      ? childSlides.map((child, index) => ({
          id: child.id,
          slideIndex: index + 1,
          mediaType: child.media_type || "UNKNOWN",
          imageUrl: child.thumbnail_url || child.media_url || null,
        }))
      : [
          {
            id: item.id,
            slideIndex: 1,
            mediaType: item.media_type || "UNKNOWN",
            imageUrl: item.thumbnail_url || item.media_url || null,
          },
        ];

    return {
      id: item.id,
      caption: (item.caption || "").slice(0, 2_200),
      mediaType: item.media_type || "UNKNOWN",
      mediaProductType: item.media_product_type || item.media_type || "UNKNOWN",
      permalink: item.permalink || "",
      previewUrl: item.thumbnail_url || item.media_url || null,
      timestamp: item.timestamp || "",
      metrics,
      comments: commentsResult.status === "fulfilled" ? commentsResult.value : [],
      slides,
    };
  });

  return {
    profile,
    posts,
    warnings,
    collectedAt: new Date().toISOString(),
  };
}
