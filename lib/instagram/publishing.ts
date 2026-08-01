type InstagramPublishingProfile = {
  id: string;
  username: string;
  accountType: string;
};

type InstagramContainerStatus = {
  id?: string;
  status_code?: string;
  status?: string;
};

type InstagramPublishResult = {
  mediaId: string;
  containerId: string;
  permalink: string | null;
};

type GraphErrorPayload = {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
  };
};

export class InstagramPublishingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
  ) {
    super(message);
    this.name = "InstagramPublishingError";
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

async function graphRequest<T>(
  path: string,
  options: {
    method?: "GET" | "POST";
    params?: Record<string, string>;
    timeoutMs?: number;
  } = {},
) {
  const { accessToken, version } = graphConfig();
  const url = new URL(
    `https://graph.instagram.com/${version}/${path.replace(/^\//, "")}`,
  );
  const method = options.method ?? "GET";
  const params = options.params ?? {};

  if (method === "GET") {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(method === "POST"
        ? { "Content-Type": "application/x-www-form-urlencoded" }
        : {}),
    },
    body: method === "POST" ? new URLSearchParams(params) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });

  const payload = (await response.json().catch(() => ({}))) as T &
    GraphErrorPayload;
  if (!response.ok || payload.error) {
    const graphError = payload.error;
    throw new InstagramPublishingError(
      graphError?.message ??
        `Instagram publishing request failed with ${response.status}.`,
      response.status,
      graphError?.code,
      graphError?.error_subcode,
    );
  }

  return payload;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForContainer(
  containerId: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latestStatus = "UNKNOWN";

  while (Date.now() < deadline) {
    const result = await graphRequest<InstagramContainerStatus>(containerId, {
      params: { fields: "id,status_code,status" },
    });
    latestStatus = result.status_code ?? "UNKNOWN";

    if (latestStatus === "FINISHED" || latestStatus === "PUBLISHED") return;
    if (
      latestStatus === "ERROR" ||
      latestStatus === "EXPIRED" ||
      latestStatus === "FAILED"
    ) {
      throw new InstagramPublishingError(
        result.status ??
          `Instagram media container ${containerId} failed with ${latestStatus}.`,
        502,
      );
    }

    await delay(2_000);
  }

  throw new InstagramPublishingError(
    `Instagram media processing timed out (last status: ${latestStatus}).`,
    504,
  );
}

export async function getInstagramPublishingProfile(): Promise<InstagramPublishingProfile> {
  const profile = await graphRequest<{
    id?: string;
    user_id?: string;
    username?: string;
    account_type?: string;
  }>("me", {
    params: {
      fields: "id,user_id,username,account_type",
    },
  });
  const id = profile.user_id || profile.id;
  if (!id) {
    throw new InstagramPublishingError(
      "The connected Instagram account did not return a user ID.",
      502,
    );
  }

  return {
    id,
    username: profile.username ?? "unknown",
    accountType: profile.account_type ?? "PROFESSIONAL",
  };
}

export async function publishInstagramCarousel(input: {
  imageUrls: string[];
  caption: string;
}): Promise<InstagramPublishResult> {
  if (input.imageUrls.length < 2 || input.imageUrls.length > 10) {
    throw new InstagramPublishingError(
      "Instagram carousel publishing requires between 2 and 10 images.",
      400,
    );
  }

  const profile = await getInstagramPublishingProfile();
  const childContainers = await Promise.all(
    input.imageUrls.map(async (imageUrl) => {
      const container = await graphRequest<{ id?: string }>(
        `${profile.id}/media`,
        {
          method: "POST",
          params: {
            image_url: imageUrl,
            is_carousel_item: "true",
          },
        },
      );
      if (!container.id) {
        throw new InstagramPublishingError(
          "Instagram did not return an image container ID.",
          502,
        );
      }
      return container.id;
    }),
  );

  await Promise.all(childContainers.map((id) => waitForContainer(id)));

  const carousel = await graphRequest<{ id?: string }>(
    `${profile.id}/media`,
    {
      method: "POST",
      params: {
        media_type: "CAROUSEL",
        children: childContainers.join(","),
        caption: input.caption,
      },
    },
  );
  if (!carousel.id) {
    throw new InstagramPublishingError(
      "Instagram did not return a carousel container ID.",
      502,
    );
  }

  await waitForContainer(carousel.id);

  const published = await graphRequest<{ id?: string }>(
    `${profile.id}/media_publish`,
    {
      method: "POST",
      params: { creation_id: carousel.id },
    },
  );
  if (!published.id) {
    throw new InstagramPublishingError(
      "Instagram did not return the published media ID.",
      502,
    );
  }

  let permalink: string | null = null;
  try {
    const media = await graphRequest<{ permalink?: string }>(published.id, {
      params: { fields: "id,permalink" },
    });
    permalink = media.permalink ?? null;
  } catch {
    // The post is already published. A missing permalink must not turn a
    // successful publish into an error; the caller can fall back to profile.
  }

  return {
    mediaId: published.id,
    containerId: carousel.id,
    permalink,
  };
}

export function isInstagramPublishingConfigured() {
  return Boolean(process.env.INSTAGRAM_ACCESS_TOKEN?.trim());
}
