import { loadMarketerSkill } from "@/lib/marketer-agent/skills";
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

function verifyReferences(
  modelOutput: ReferenceScoutModelOutput,
  input: ReferenceScoutInput,
  sources: string[],
): InstagramReferenceContext {
  const seen = new Set<string>();
  const droppedCount = modelOutput.references.length;
  const references = modelOutput.references
    .map((reference) => {
      const instagramUrl = canonicalInstagramPostUrl(reference.instagramUrl);
      if (!instagramUrl || seen.has(instagramUrl)) return null;
      seen.add(instagramUrl);
      const hasObservedMetric = Object.values(reference.observedMetrics).some(
        (value) => typeof value === "number",
      );
      return {
        ...reference,
        instagramUrl,
        performanceSignal: hasObservedMetric
          ? reference.performanceSignal
          : ("unknown" as const),
        confidence: hasObservedMetric
          ? reference.confidence
          : Math.min(reference.confidence, 0.7),
        sourceUrls: Array.from(
          new Set([instagramUrl, ...reference.sourceUrls]),
        ).slice(0, 12),
      };
    })
    .filter((reference) => reference !== null)
    .slice(0, input.maxReferences)
    .map((reference, index) => ({ ...reference, rank: index + 1 }));

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
  const limitations = [...modelOutput.searchSummary.limitations];
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

export async function scoutInstagramReferences(
  input: ReferenceScoutInput,
): Promise<InstagramReferenceContext> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new ReferenceScoutError("OPENAI_API_KEY is not configured.");

  const model =
    process.env.OPENAI_REFERENCE_MODEL?.trim() ||
    process.env.OPENAI_MODEL?.trim() ||
    "gpt-5.6";
  const skillInstructions = await loadMarketerSkill(
    "scout-instagram-references",
  );
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

  const modelOutput = JSON.parse(
    extractOutputText(payload),
  ) as ReferenceScoutModelOutput;
  return verifyReferences(modelOutput, input, collectSourceUrls(payload));
}
