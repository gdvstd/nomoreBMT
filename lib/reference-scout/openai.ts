import { loadMarketerSkill } from "@/lib/marketer-agent/skills";
import {
  ApifyReferenceScoutError,
  collectApifyInstagramCandidates,
  type ApifyCollectionResult,
  type ApifyPostCandidate,
} from "./apify";
import {
  referenceScoutJsonSchema,
  type InstagramReferenceContext,
  type ReferenceScoutInput,
  type ReferenceScoutModelOutput,
} from "./schema";

type OpenAIWebResponse = {
  output_text?: string;
  output?: Array<{
    type?: string;
    action?: {
      sources?: Array<{ url?: string }>;
    };
    results?: Array<{
      image_url?: string;
      source_website_url?: string;
    }>;
    content?: Array<{
      type?: string;
      text?: string;
      refusal?: string;
      annotations?: Array<{ url?: string }>;
    }>;
  }>;
  error?: { message?: string };
};

export class ReferenceScoutError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ReferenceScoutError";
  }
}

function extractOutputText(response: OpenAIWebResponse) {
  if (response.output_text) return response.output_text;

  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "refusal") {
        throw new ReferenceScoutError(
          content.refusal || "The reference search was refused.",
        );
      }
      if (typeof content.text === "string") return content.text;
    }
  }

  throw new ReferenceScoutError(
    "OpenAI response did not contain structured reference output.",
  );
}

function collectSourceUrls(response: OpenAIWebResponse) {
  const sources = new Set<string>();

  for (const item of response.output || []) {
    for (const source of item.action?.sources || []) {
      if (source.url) sources.add(source.url);
    }
    for (const result of item.results || []) {
      if (result.source_website_url) sources.add(result.source_website_url);
    }
    for (const content of item.content || []) {
      for (const annotation of content.annotations || []) {
        if (annotation.url) sources.add(annotation.url);
      }
    }
  }

  return [...sources].slice(0, 100);
}

function canonicalInstagramPostUrl(value: string) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "instagram.com") return null;
    if (!/^\/(p|reel|tv)\/[^/?#]+\/?$/i.test(parsed.pathname)) return null;

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

type VerificationOptions = {
  provider: "apify" | "web_search";
  candidates?: ApifyPostCandidate[];
  queries?: string[];
  limitations?: string[];
};

function round(value: number, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function weightedPublicReactions(
  reference: ReferenceScoutModelOutput["references"][number],
) {
  const likes = reference.observedMetrics.likes;
  const comments = reference.observedMetrics.comments;
  if (likes === null || comments === null) return null;
  return likes + 3 * comments;
}

function recencyScore(
  publishedAt: string | null,
  timeRange: ReferenceScoutInput["timeRange"],
) {
  if (!publishedAt) return null;
  const timestamp = new Date(publishedAt).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  const horizon =
    timeRange === "7d"
      ? 7
      : timeRange === "30d"
        ? 30
        : timeRange === "90d"
          ? 90
          : 365;
  return Math.max(0, Math.min(1, 1 - ageDays / horizon));
}

function evidenceCoverage(
  reference: ReferenceScoutModelOutput["references"][number],
) {
  const observed = [
    reference.observedMetrics.likes,
    reference.observedMetrics.comments,
    reference.publishedAt,
    reference.format === "unknown" ? null : reference.format,
  ];
  return observed.filter((value) => value !== null).length / observed.length;
}

function rankReferences(
  references: ReferenceScoutModelOutput["references"],
  input: ReferenceScoutInput,
) {
  const reactions = references.map(weightedPublicReactions);
  const maxReactions = Math.max(
    0,
    ...reactions.filter((value): value is number => value !== null),
  );

  const scored = references.map((reference) => {
    const publicReactions = weightedPublicReactions(reference);
    const performanceScore =
      publicReactions === null
        ? null
        : maxReactions > 0
          ? Math.log1p(publicReactions) / Math.log1p(maxReactions)
          : 0;
    const freshness = recencyScore(reference.publishedAt, input.timeRange);
    const coverage = evidenceCoverage(reference);
    const weightedParts = [
      { value: reference.match.topicSimilarity, weight: 0.45 },
      { value: performanceScore, weight: 0.3 },
      { value: freshness, weight: 0.15 },
      { value: coverage, weight: 0.1 },
    ].filter(
      (part): part is { value: number; weight: number } =>
        part.value !== null,
    );
    const weightTotal = weightedParts.reduce(
      (sum, part) => sum + part.weight,
      0,
    );
    const referenceScore =
      weightTotal > 0
        ? (weightedParts.reduce(
            (sum, part) => sum + part.value * part.weight,
            0,
          ) /
            weightTotal) *
          100
        : 0;
    const performanceSignal =
      performanceScore === null
        ? ("unknown" as const)
        : performanceScore >= 0.8
          ? ("high" as const)
          : performanceScore >= 0.45
            ? ("medium" as const)
            : ("low" as const);

    return {
      ...reference,
      performanceSignal,
      rankingSignals: {
        weightedPublicReactions: publicReactions,
        performanceScore:
          performanceScore === null ? null : round(performanceScore),
        recencyScore: freshness === null ? null : round(freshness),
        evidenceCoverage: round(coverage),
        referenceScore: round(referenceScore, 1),
      },
    };
  });

  const accountCounts = new Map<string, number>();
  return scored
    .sort(
      (a, b) =>
        b.rankingSignals.referenceScore - a.rankingSignals.referenceScore,
    )
    .filter((reference) => {
      if (!reference.creatorHandle) return true;
      const key = reference.creatorHandle.toLowerCase();
      const count = accountCounts.get(key) || 0;
      if (count >= 2) return false;
      accountCounts.set(key, count + 1);
      return true;
    })
    .slice(0, Math.min(3, input.maxReferences))
    .map((reference, index) => ({ ...reference, rank: index + 1 }));
}

function verifyReferences(
  modelOutput: ReferenceScoutModelOutput,
  input: ReferenceScoutInput,
  sources: string[],
  options: VerificationOptions,
): InstagramReferenceContext {
  const candidateByUrl = new Map(
    (options.candidates || []).map((candidate) => [
      candidate.instagramUrl,
      candidate,
    ]),
  );
  const seen = new Set<string>();
  const droppedCount = modelOutput.references.length;
  const verifiedCandidates = modelOutput.references
    .map((reference) => {
      const instagramUrl = canonicalInstagramPostUrl(reference.instagramUrl);
      if (!instagramUrl || seen.has(instagramUrl)) return null;
      const candidate = candidateByUrl.get(instagramUrl);
      if (options.provider === "apify" && !candidate) return null;
      seen.add(instagramUrl);
      const observedMetrics = candidate
        ? {
            likes: candidate.likes,
            comments: candidate.comments,
            views: candidate.views,
            saves: null,
            shares: null,
          }
        : reference.observedMetrics;
      const hasObservedMetric = Object.values(observedMetrics).some(
        (value) => typeof value === "number",
      );
      const metricCaveat = candidate
        ? [
            "Apify에서 수집한 공개 지표만 사용함.",
            "성과 점수는 작성자 follower 수 없이 공개 좋아요와 댓글만 사용함.",
            "공개되지 않은 저장·공유 수치는 unknown으로 유지함.",
          ]
            .filter(Boolean)
            .join(" ")
        : reference.metricCaveat;
      return {
        ...reference,
        instagramUrl,
        previewImageUrls: candidate?.imageUrls.slice(0, 2) ?? [],
        creatorHandle:
          candidate?.creatorHandle ?? reference.creatorHandle,
        format: candidate?.format ?? reference.format,
        publishedAt: candidate?.publishedAt ?? reference.publishedAt,
        observedMetrics,
        metricCaveat,
        performanceSignal: hasObservedMetric
          ? reference.performanceSignal
          : ("unknown" as const),
        confidence: hasObservedMetric
          ? reference.confidence
          : Math.min(reference.confidence, 0.7),
        sourceUrls: Array.from(
          new Set([
            instagramUrl,
            ...(candidate?.sourceHashtagUrls || []),
            ...reference.sourceUrls,
          ]),
        ).slice(0, 12),
      };
    })
    .filter((reference) => reference !== null)
    .slice(0, 8);
  const references = rankReferences(verifiedCandidates, input);

  const verifiedUrls = new Set(references.map((item) => item.instagramUrl));
  const patterns = modelOutput.patterns
    .map((pattern) => ({
      ...pattern,
      evidenceReferenceUrls: pattern.evidenceReferenceUrls
        .map(canonicalInstagramPostUrl)
        .filter(
          (url): url is string => Boolean(url && verifiedUrls.has(url)),
        ),
    }))
    .filter((pattern) => pattern.evidenceReferenceUrls.length > 0);

  const removedCount = droppedCount - references.length;
  const limitations = [
    ...(options.limitations || []),
    ...modelOutput.searchSummary.limitations,
  ];
  if (removedCount > 0) {
    limitations.push(
      `${removedCount}개 후보는 직접 Instagram 게시물 URL 검증에 실패하여 제외됨.`,
    );
  }
  const hasPerformanceEvidence = references.some((reference) =>
    Object.values(reference.observedMetrics).some(
      (value) => typeof value === "number",
    ),
  );
  if (references.length > 0 && !hasPerformanceEvidence) {
    limitations.push(
      "공개된 성과 수치가 없어 reference의 인기도를 사용자 계정과 직접 비교할 수 없음.",
    );
  }

  const searchConfidence =
    references.length === 0
      ? "low"
      : !hasPerformanceEvidence &&
          modelOutput.searchSummary.confidence === "high"
        ? "medium"
        : modelOutput.searchSummary.confidence;

  return {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    query: {
      topic: input.topic,
      objective: input.objective,
      timeRange: input.timeRange,
      region: input.region,
      formatFocus: input.formatFocus,
    },
    searchSummary: {
      ...modelOutput.searchSummary,
      provider: options.provider,
      queries: options.queries || modelOutput.searchSummary.queries,
      verifiedReferenceCount: references.length,
      confidence: searchConfidence,
      limitations,
    },
    references,
    patterns,
    editorContext: references.length
      ? modelOutput.editorContext
      : {
          adoptionIdeas: [],
          visualDirections: [],
          hookDirections: [],
          avoid: [
            "검증된 Instagram reference가 없으므로 검색 결과를 창작 근거로 사용하지 않는다.",
          ],
          evidenceRules: modelOutput.editorContext.evidenceRules,
        },
    sources,
  };
}

function emptyApifyContext(
  input: ReferenceScoutInput,
  collection: ApifyCollectionResult,
): InstagramReferenceContext {
  return {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    query: {
      topic: input.topic,
      objective: input.objective,
      timeRange: input.timeRange,
      region: input.region,
      formatFocus: input.formatFocus,
    },
    searchSummary: {
      provider: "apify",
      queries: collection.searchTerms,
      verifiedReferenceCount: 0,
      confidence: "low",
      limitations: [
        ...collection.limitations,
        "Apify가 조건에 맞는 공개 단일 이미지 또는 캐러셀 게시물을 반환하지 않음.",
      ],
    },
    references: [],
    patterns: [],
    editorContext: {
      adoptionIdeas: [],
      visualDirections: [],
      hookDirections: [],
      avoid: [
        "검증된 Instagram reference가 없으므로 검색 결과를 창작 근거로 사용하지 않는다.",
      ],
      evidenceRules: [
        "누락된 공개 지표를 0으로 취급하거나 추정하지 않는다.",
        "검증된 직접 Instagram 게시물 URL만 근거로 사용한다.",
      ],
    },
    sources: collection.sources,
  };
}

async function analyzeApifyCandidates(
  input: ReferenceScoutInput,
  collection: ApifyCollectionResult,
  apiKey: string,
  model: string,
  skillInstructions: string,
  onProgress?: ScoutProgress,
) {
  const candidates = collection.candidates.slice(0, 18);
  onProgress?.(`후보 ${candidates.length}개를 이미지·캡션 기준으로 분석하는 중`);
  const modelCandidates = candidates.map(({ imageUrls: _imageUrls, ...candidate }) => ({
    ...candidate,
    mediaEvidenceCount: _imageUrls.length,
  }));
  const userContent: Array<Record<string, unknown>> = [
    {
      type: "input_text",
      text: JSON.stringify(
        {
          currentDate: new Date().toISOString(),
          request: input,
          provider: "apify",
          searchTerms: collection.searchTerms,
          hashtagUrls: collection.hashtagUrls,
          candidates: modelCandidates,
          requirement: [
            "Select only topic-matched candidates from the supplied list.",
            "Select and analyze at most 3 references after checking format, topic relevance, and duplicate URLs.",
            "Set searchSummary.provider to apify.",
            "Copy public likes, comments, dates, formats, handles, and URLs exactly.",
            "The server recalculates rankingSignals; include schema-valid placeholder values without inventing missing evidence.",
            "Analyze only visible captions and supplied preview images.",
            "For every selected reference, analyze both the hook and reusable design evidence: layout, hierarchy, typography, color, image treatment, spacing, information density, and carousel flow when visible.",
            "Do not retry discovery or request more candidates when fewer than 3 valid references exist.",
          ],
        },
        null,
        2,
      ),
    },
  ];

  let imageCount = 0;
  for (const [index, candidate] of candidates.entries()) {
    const imageUrl = candidate.imageUrls[0];
    if (!imageUrl || imageCount >= 18) continue;
    userContent.push({
      type: "input_text",
      text: `Candidate ${index + 1}: ${candidate.instagramUrl}`,
    });
    userContent.push({
      type: "input_image",
      image_url: imageUrl,
      detail: "low",
    });
    imageCount += 1;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: "low" },
      input: [
        {
          role: "system",
          content: [
            "Follow the marketer skill below as the authoritative workflow.",
            skillInstructions,
            "Apify already performed discovery. Do not invent candidates, URLs, metrics, or visual evidence.",
            "Return Korean analysis and preserve exact evidence URLs.",
          ].join("\n\n"),
        },
        {
          role: "user",
          content: userContent,
        },
      ],
      text: {
        verbosity: "medium",
        format: {
          type: "json_schema",
          name: "instagram_reference_context",
          strict: true,
          schema: referenceScoutJsonSchema,
        },
      },
      max_output_tokens: 7_000,
      store: false,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(150_000),
  });

  const payload = (await response.json().catch(() => ({}))) as OpenAIWebResponse;
  if (!response.ok) {
    throw new ReferenceScoutError(
      payload.error?.message ||
        `OpenAI Apify candidate analysis failed with ${response.status}.`,
      response.status,
    );
  }
  onProgress?.("분석 결과에서 레퍼런스를 검증·랭킹하는 중");
  const modelOutput = JSON.parse(
    extractOutputText(payload),
  ) as ReferenceScoutModelOutput;
  return verifyReferences(modelOutput, input, collection.sources, {
    provider: "apify",
    candidates: collection.candidates,
    queries: collection.searchTerms,
    limitations: collection.limitations,
  });
}

export type ScoutProgress = (message: string) => void;

export async function scoutInstagramReferences(
  input: ReferenceScoutInput,
  onProgress?: ScoutProgress,
): Promise<InstagramReferenceContext> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new ReferenceScoutError("OPENAI_API_KEY is not configured.");

  const model =
    process.env.OPENAI_REFERENCE_MODEL?.trim() ||
    process.env.OPENAI_MODEL?.trim() ||
    "gpt-5.6";
  onProgress?.("조사 스킬을 불러오고 검색을 준비하는 중");
  const skillInstructions = await loadMarketerSkill(
    "scout-instagram-references",
  );
  const apifyToken = process.env.APIFY_API_TOKEN?.trim();
  if (apifyToken) {
    try {
      onProgress?.("Apify로 주제와 유사한 해시태그·공개 게시물 후보를 수집하는 중");
      const collection = await collectApifyInstagramCandidates(
        input,
        apifyToken,
      );
      onProgress?.(
        `공개 게시물 후보 ${collection.candidates.length}개 확보` +
          (collection.searchTerms.length
            ? ` · 검색어 [${collection.searchTerms.join(", ")}]`
            : ""),
      );
      if (!collection.candidates.length) {
        onProgress?.("조건에 맞는 공개 게시물이 없어 사용자 사진 근거로 진행");
        return emptyApifyContext(input, collection);
      }
      return await analyzeApifyCandidates(
        input,
        collection,
        apiKey,
        model,
        skillInstructions,
        onProgress,
      );
    } catch (error) {
      if (error instanceof ApifyReferenceScoutError) {
        throw new ReferenceScoutError(
          `Apify ${error.stage} 단계 실패: ${error.message}`,
          error.status,
        );
      }
      throw error;
    }
  }

  onProgress?.("웹 검색으로 유사한 공개 Instagram 게시물을 탐색하는 중");
  const country = /^[a-z]{2}$/i.test(input.region)
    ? input.region.toUpperCase()
    : null;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: "low" },
      tools: [
        {
          type: "web_search",
          search_context_size: "medium",
          search_content_types: ["text", "image"],
          image_settings: {
            max_results: Math.min(12, input.maxReferences * 2),
            caption: true,
          },
          external_web_access: true,
          ...(country
            ? {
                user_location: {
                  type: "approximate",
                  country,
                },
              }
            : {}),
        },
      ],
      tool_choice: "required",
      include: [
        "web_search_call.action.sources",
        "web_search_call.results",
      ],
      input: [
        {
          role: "system",
          content: [
            "Follow the marketer skill below as the authoritative workflow.",
            skillInstructions,
            "Use web search. Return Korean analysis with exact source URLs.",
            "A reference is valid only when instagramUrl is a direct Instagram /p/, /reel/, or /tv/ URL.",
            "Never manufacture engagement metrics or URLs.",
            "Set searchSummary.provider to web_search.",
          ].join("\n\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            currentDate: new Date().toISOString(),
            request: input,
            requirement:
              "Search the public web for topic-matched Instagram posts, verify direct post URLs, and return only evidence-backed reusable patterns.",
          }),
        },
      ],
      text: {
        verbosity: "medium",
        format: {
          type: "json_schema",
          name: "instagram_reference_context",
          strict: true,
          schema: referenceScoutJsonSchema,
        },
      },
      max_output_tokens: 6_000,
      store: false,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(150_000),
  });

  const payload = (await response.json().catch(() => ({}))) as OpenAIWebResponse;
  if (!response.ok) {
    throw new ReferenceScoutError(
      payload.error?.message ||
        `OpenAI reference search failed with ${response.status}.`,
      response.status,
    );
  }

  onProgress?.("검색 결과에서 직접 게시물 URL을 검증·랭킹하는 중");
  const modelOutput = JSON.parse(
    extractOutputText(payload),
  ) as ReferenceScoutModelOutput;
  return verifyReferences(modelOutput, input, collectSourceUrls(payload), {
    provider: "web_search",
    limitations: [
      "APIFY_API_TOKEN이 없어 기존 OpenAI 웹검색 fallback을 사용함.",
    ],
  });
}
