import type {
  ReferenceFormat,
  ReferenceScoutInput,
} from "./schema";

const APIFY_API_BASE = "https://api.apify.com/v2";
const INSTAGRAM_SCRAPER_ACTOR =
  process.env.APIFY_INSTAGRAM_SCRAPER_ACTOR?.trim() ||
  "apify~instagram-scraper";
const APIFY_SOURCE_URL = "https://apify.com/apify/instagram-scraper";

type UnknownRecord = Record<string, unknown>;

export type ApifyPostCandidate = {
  instagramUrl: string;
  shortCode: string | null;
  creatorHandle: string | null;
  caption: string;
  format: Exclude<ReferenceFormat, "reel" | "unknown">;
  publishedAt: string | null;
  likes: number | null;
  comments: number | null;
  views: number | null;
  imageUrls: string[];
  carouselImageCount: number | null;
  sourceHashtagUrls: string[];
};

export type ApifyCollectionResult = {
  candidates: ApifyPostCandidate[];
  searchTerms: string[];
  hashtagUrls: string[];
  sources: string[];
  limitations: string[];
};

export class ApifyReferenceScoutError extends Error {
  constructor(
    message: string,
    readonly stage: "post_collection",
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApifyReferenceScoutError";
  }
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function stringValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function publicNumber(...values: unknown[]) {
  for (const value of values) {
    const number =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim()
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function canonicalInstagramUrl(value: string, pattern: RegExp) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "instagram.com" || !pattern.test(parsed.pathname)) return null;
    parsed.protocol = "https:";
    parsed.hostname = "www.instagram.com";
    parsed.search = "";
    parsed.hash = "";
    if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
    return parsed.toString();
  } catch {
    return null;
  }
}

function canonicalPostUrl(value: string) {
  return canonicalInstagramUrl(value, /^\/p\/[^/?#]+\/?$/i);
}

function canonicalHashtagUrl(value: string) {
  return canonicalInstagramUrl(
    value,
    /^\/explore\/tags\/[^/?#]+\/?$/i,
  );
}

function collectImageUrls(record: UnknownRecord) {
  const urls = new Set<string>();
  const directKeys = [
    "displayUrl",
    "imageUrl",
    "thumbnailUrl",
    "display_url",
  ];
  for (const key of directKeys) {
    const value = record[key];
    if (typeof value === "string" && /^https?:\/\//i.test(value)) {
      urls.add(value);
    }
  }

  for (const key of ["images", "childPosts", "carouselMedia"]) {
    const items = record[key];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (typeof item === "string" && /^https?:\/\//i.test(item)) {
        urls.add(item);
        continue;
      }
      const child = asRecord(item);
      if (!child) continue;
      const childUrl = stringValue(
        child.displayUrl,
        child.imageUrl,
        child.thumbnailUrl,
        child.url,
      );
      if (childUrl && /^https?:\/\//i.test(childUrl)) urls.add(childUrl);
    }
  }

  return [...urls].slice(0, 10);
}

function inferFormat(record: UnknownRecord): ApifyPostCandidate["format"] | null {
  const productType = stringValue(record.productType, record.product_type);
  const type = stringValue(record.type, record.mediaType, record.media_type);
  if (
    productType?.toLowerCase() === "clips" ||
    type?.toLowerCase().includes("video") ||
    type?.toLowerCase().includes("reel")
  ) {
    return null;
  }

  const childCount = Array.isArray(record.childPosts)
    ? record.childPosts.length
    : Array.isArray(record.carouselMedia)
      ? record.carouselMedia.length
      : 0;
  const carouselImageCount = publicNumber(
    record.carouselImageCount,
    record.carousel_media_count,
  );
  if (
    type?.toLowerCase() === "sidecar" ||
    type?.toLowerCase().includes("carousel") ||
    childCount > 1 ||
    (carouselImageCount !== null && carouselImageCount > 1)
  ) {
    return "carousel";
  }
  if (
    !type ||
    type.toLowerCase() === "image" ||
    type.toLowerCase() === "graphimage"
  ) {
    return "single_image";
  }
  return null;
}

function normalizeTimestamp(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function flattenPostRecords(items: unknown[]) {
  const records: UnknownRecord[] = [];
  for (const item of items) {
    const record = asRecord(item);
    if (!record) continue;
    const nested = [record.latestPosts, record.posts, record.topPosts];
    const nestedPosts = nested.find(Array.isArray);
    if (nestedPosts && Array.isArray(nestedPosts)) {
      for (const post of nestedPosts) {
        const postRecord = asRecord(post);
        if (postRecord) records.push(postRecord);
      }
    } else {
      records.push(record);
    }
  }
  return records;
}

function parseCandidate(record: UnknownRecord): ApifyPostCandidate | null {
  const shortCode = stringValue(record.shortCode, record.shortcode);
  const rawUrl =
    stringValue(record.url, record.postUrl, record.inputUrl) ||
    (shortCode ? `https://www.instagram.com/p/${shortCode}/` : null);
  const instagramUrl = rawUrl ? canonicalPostUrl(rawUrl) : null;
  const format = inferFormat(record);
  if (!instagramUrl || !format) return null;

  const owner = asRecord(record.owner);
  const inputUrl = stringValue(record.inputUrl);
  const sourceHashtagUrl = inputUrl ? canonicalHashtagUrl(inputUrl) : null;

  return {
    instagramUrl,
    shortCode,
    creatorHandle: stringValue(
      record.ownerUsername,
      record.username,
      owner?.username,
    ),
    caption: stringValue(record.caption, record.text) || "",
    format,
    publishedAt: normalizeTimestamp(record.timestamp),
    likes: publicNumber(record.likesCount, record.likes),
    comments: publicNumber(record.commentsCount, record.comments),
    views: publicNumber(
      record.videoViewCount,
      record.videoPlayCount,
      record.viewsCount,
      record.playCount,
    ),
    imageUrls: collectImageUrls(record),
    carouselImageCount: publicNumber(
      record.carouselImageCount,
      record.carousel_media_count,
    ),
    sourceHashtagUrls: sourceHashtagUrl ? [sourceHashtagUrl] : [],
  };
}

function dedupeCandidates(candidates: ApifyPostCandidate[]) {
  const byUrl = new Map<string, ApifyPostCandidate>();
  for (const candidate of candidates) {
    const existing = byUrl.get(candidate.instagramUrl);
    if (!existing) {
      byUrl.set(candidate.instagramUrl, candidate);
      continue;
    }
    byUrl.set(candidate.instagramUrl, {
      ...existing,
      likes: existing.likes ?? candidate.likes,
      comments: existing.comments ?? candidate.comments,
      views: existing.views ?? candidate.views,
      imageUrls: [...new Set([...existing.imageUrls, ...candidate.imageUrls])],
      sourceHashtagUrls: [
        ...new Set([
          ...existing.sourceHashtagUrls,
          ...candidate.sourceHashtagUrls,
        ]),
      ],
    });
  }
  return [...byUrl.values()];
}

function buildSearchTerms(input: ReferenceScoutInput) {
  const explicit = (input.searchTerms ?? [])
    .map((term) =>
      term
        .replace(/[#@]/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((term) => term.length >= 2);
  const stopwords = new Set([
    "추천",
    "게시물",
    "카드뉴스",
    "콘텐츠",
    "인스타그램",
    "여행",
    "여행지",
    "방문",
    "방문한",
    "다녀온",
    "소개",
    "정리",
    "중",
    "instagram",
    "post",
    "posts",
  ]);
  const cleanedTopic = input.topic
    .replace(/[#@]/g, " ")
    .replace(/[!?.,:;()[\]{}"'`~^|<>+=*&%$\\/_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = cleanedTopic
    .split(" ")
    .map((token) =>
      token
        .trim()
        .replace(/(에서|으로|에게|한테|까지|부터|처럼|보다|하고|이며|이고|과|와|을|를|은|는|이|가|의|에)$/u, ""),
    )
    .filter(
      (token) =>
        token.length >= 2 &&
        !stopwords.has(token.toLowerCase()) &&
        !/^\d+(박|일|주|개월|시간)$/u.test(token),
    );
  const location = tokens[0] || "";
  const foodIntent = tokens.some((token) =>
    /맛집|식당|음식|메뉴|카페|디저트/u.test(token),
  );
  const focusedTerms = foodIntent && location
    ? [
        `${location}맛집`,
        `${location}음식`,
        `${location}식당`,
      ]
    : [tokens.slice(0, 2).join(""), ...tokens];
  const derived = [...new Set(focusedTerms)].filter((term) => term.length >= 2);
  // Merge the model's terms with reliable topic-derived terms. Cap the model's
  // contribution so at least one topic-derived term is always searched, which
  // prevents weak model searchTerms from zeroing out Apify candidates.
  return [...new Set([...explicit.slice(0, 2), ...derived])].slice(0, 3);
}

function onlyPostsNewerThan(timeRange: ReferenceScoutInput["timeRange"]) {
  if (timeRange === "7d") return "7 days";
  if (timeRange === "30d") return "30 days";
  if (timeRange === "90d") return "90 days";
  return undefined;
}

async function runActor(
  token: string,
  actorId: string,
  input: UnknownRecord,
  stage: ApifyReferenceScoutError["stage"],
  timeoutMs: number,
) {
  const response = await fetch(
    `${APIFY_API_BASE}/acts/${actorId}/run-sync-get-dataset-items`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const errorRecord = asRecord(payload);
    const nestedError = asRecord(errorRecord?.error);
    const message =
      stringValue(nestedError?.message, errorRecord?.message) ||
      `Apify Actor failed with ${response.status}.`;
    throw new ApifyReferenceScoutError(message, stage, response.status);
  }
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  if (Array.isArray(record?.items)) return record.items;
  return [];
}

function buildHashtagUrls(searchTerms: string[]) {
  const urls = new Set<string>();
  for (const term of searchTerms) {
    const normalized = term.replace(/\s+/g, "").replace(/[^\p{L}\p{N}_]/gu, "");
    if (normalized) {
      urls.add(
        `https://www.instagram.com/explore/tags/${encodeURIComponent(normalized)}/`,
      );
    }
  }

  return [...urls].slice(0, 3);
}

export async function collectApifyInstagramCandidates(
  input: ReferenceScoutInput,
  token: string,
): Promise<ApifyCollectionResult> {
  const searchTerms = buildSearchTerms(input);
  const limitations: string[] = [
    "Apify Instagram Scraper는 공개 Instagram 데이터를 수집하는 비공식 스크래퍼이므로 플랫폼 변경에 따라 결과가 달라질 수 있음.",
    "공개되지 않은 저장·공유 수치는 수집하거나 추정하지 않음.",
  ];

  if (input.formatFocus === "reel") {
    return {
      candidates: [],
      searchTerms,
      hashtagUrls: [],
      sources: [APIFY_SOURCE_URL],
      limitations: [
        ...limitations,
        "현재 MVP는 릴스를 제외하고 단일 이미지와 캐러셀 게시물만 탐색함.",
      ],
    };
  }

  const hashtagUrls = buildHashtagUrls(searchTerms);
  if (!hashtagUrls.length) {
    return {
      candidates: [],
      searchTerms,
      hashtagUrls,
      sources: [APIFY_SOURCE_URL],
      limitations: [
        ...limitations,
        "주제와 연결된 공개 hashtag URL을 찾지 못함.",
      ],
    };
  }

  const resultsPerHashtag = Math.ceil(18 / hashtagUrls.length);
  const postItems = await runActor(
    token,
    INSTAGRAM_SCRAPER_ACTOR,
    {
      directUrls: hashtagUrls,
      resultsType: "posts",
      resultsLimit: resultsPerHashtag,
      skipPinnedPosts: true,
      addParentData: true,
      ...(onlyPostsNewerThan(input.timeRange)
        ? { onlyPostsNewerThan: onlyPostsNewerThan(input.timeRange) }
        : {}),
    },
    "post_collection",
    110_000,
  );

  const candidates = dedupeCandidates(
    flattenPostRecords(postItems)
      .map(parseCandidate)
      .filter(
        (candidate): candidate is ApifyPostCandidate => candidate !== null,
      ),
  )
    .filter((candidate) => {
      if (input.formatFocus === "carousel") {
        return candidate.format === "carousel";
      }
      if (input.formatFocus === "single_image") {
        return candidate.format === "single_image";
      }
      return true;
    })
    .slice(0, 18);

  const sources = [
    APIFY_SOURCE_URL,
    ...hashtagUrls,
    ...candidates.map((candidate) => candidate.instagramUrl),
  ];
  return {
    candidates,
    searchTerms,
    hashtagUrls,
    sources: [...new Set(sources)].slice(0, 100),
    limitations,
  };
}
