import type { DeterministicAnalysis, InstagramDataset } from "@/lib/instagram/types";
import { loadMarketerSkill } from "@/lib/marketer-agent/skills";
import {
  marketingContextJsonSchema,
  type ModelMarketingAnalysis,
} from "./schema";

type OpenAIResponse = {
  status?: string;
  incomplete_details?: { reason?: string };
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string; refusal?: string }>;
  }>;
  error?: { message?: string };
};

export class OpenAIAnalysisError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "OpenAIAnalysisError";
  }
}

function extractOutputText(response: OpenAIResponse) {
  if (response.output_text) return response.output_text;
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "refusal") {
        throw new OpenAIAnalysisError(content.refusal || "The analysis was refused.");
      }
      if (typeof content.text === "string") return content.text;
    }
  }
  throw new OpenAIAnalysisError("OpenAI response did not contain structured output.");
}

function parseStructuredAnalysis(response: OpenAIResponse) {
  if (response.status === "incomplete") {
    throw new OpenAIAnalysisError(
      `OpenAI 계정 분석 출력이 완료되지 않았어요${response.incomplete_details?.reason ? ` (${response.incomplete_details.reason})` : ""}.`,
    502,
    );
  }

  const outputText = extractOutputText(response);
  try {
    return JSON.parse(outputText) as ModelMarketingAnalysis;
  } catch {
    throw new OpenAIAnalysisError(
      "OpenAI 계정 분석의 구조화 출력이 완전한 JSON이 아니에요. 분석 범위를 줄이거나 다시 시도해주세요.",
      502,
    );
  }
}

function compactDataset(dataset: InstagramDataset, analysis: DeterministicAnalysis) {
  const performanceById = new Map(
    analysis.performance.map((item) => [item.postId, item]),
  );
  let remainingComments = 180;

  return {
    account: dataset.profile,
    baseline: analysis.baseline,
    posts: dataset.posts.map((post) => {
      const comments = post.comments
        .slice()
        .sort((a, b) => b.likeCount - a.likeCount)
        .slice(0, Math.max(0, Math.min(20, remainingComments)));
      remainingComments -= comments.length;

      return {
        id: post.id,
        mediaType: post.mediaType,
        mediaProductType: post.mediaProductType,
        timestamp: post.timestamp,
        caption: post.caption.slice(0, 1_800),
        metrics: post.metrics,
        performance: performanceById.get(post.id),
        comments: comments.map((comment) => ({
          id: comment.id,
          text: comment.text.slice(0, 400),
          likeCount: comment.likeCount,
        })),
        slides: post.slides.map((slide) => ({
          id: slide.id,
          slideIndex: slide.slideIndex,
          mediaType: slide.mediaType,
          hasImage: Boolean(slide.imageUrl),
        })),
      };
    }),
    topPostIds: analysis.topPostIds,
    lowPostIds: analysis.lowPostIds,
    collectionWarnings: dataset.warnings,
  };
}

function buildVisualInputs(dataset: InstagramDataset) {
  const maxImages = Math.min(
    30,
    Math.max(1, Number(process.env.VISUAL_ANALYSIS_MAX_IMAGES || 20)),
  );
  const visualInputs: Array<
    | { type: "input_text"; text: string }
    | { type: "input_image"; image_url: string; detail: "original" }
  > = [];
  let count = 0;

  for (const post of dataset.posts) {
    for (const slide of post.slides) {
      if (!slide.imageUrl || count >= maxImages) continue;
      visualInputs.push({
        type: "input_text",
        text: `VISUAL_EVIDENCE postId=${post.id} slideId=${slide.id} slideIndex=${slide.slideIndex}/${post.slides.length}`,
      });
      visualInputs.push({
        type: "input_image",
        image_url: slide.imageUrl,
        detail: "original",
      });
      count += 1;
    }
  }

  return { visualInputs, imageCount: count, maxImages };
}

export async function generateMarketingContext(
  dataset: InstagramDataset,
  deterministic: DeterministicAnalysis,
  focus: string,
): Promise<ModelMarketingAnalysis> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");

  const model = process.env.OPENAI_MODEL?.trim() || "gpt-5.6";
  const inputData = compactDataset(dataset, deterministic);
  const { visualInputs, imageCount, maxImages } = buildVisualInputs(dataset);
  const skillInstructions = await loadMarketerSkill("analyze-instagram-account");
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
            "당신은 Instagram 계정 데이터를 편집자 Agent가 사용할 근거 중심의 마케팅 context로 변환하는 분석 모델이다.",
            "정량값은 입력된 metrics와 deterministic baseline만 사용한다.",
            "관측 사실과 해석을 구분하고, 인과관계를 단정하지 않는다.",
            "각 핵심 finding에는 실제 post ID 또는 comment ID를 evidence로 연결한다.",
            "입력 이미지마다 앞의 VISUAL_EVIDENCE 라벨을 사용해 postId, slideId, slideIndex를 정확히 연결한다.",
            "카드뉴스의 작은 한글 텍스트 가독성, 글자와 배경 대비, 정보 위계, 여백, 정렬, 잘림, 시선 흐름을 평가한다.",
            "carousel 전체에서 첫 장의 hook, 중간 장의 정보 전개, 마지막 장의 CTA, 슬라이드 순서와 중복을 평가한다.",
            "이미지만 보고 실제 화면 크기의 정확한 글자 크기를 단정하지 말고 관찰 가능한 문제와 추정을 구분한다.",
            "댓글 작성자 신원은 추론하지 않는다.",
            "데이터가 부족하면 limitation에 명시하고 confidence를 낮춘다.",
            "출력은 한국어로 작성하되 ID와 metric 이름은 원문을 유지한다.",
            "출력은 간결하게 작성한다. winningPatterns와 weakPatterns는 각각 최대 3개, commentThemes는 최대 5개, visualAnalysis.slides와 carousels는 가장 중요한 근거만 최대 8개씩 작성한다.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                goal:
                  focus ||
                  "기존 게시물 성과, 댓글 반응, 카드뉴스 이미지를 분석하여 다음 게시물을 만드는 편집자 Agent용 context 생성",
                visualCoverage: {
                  providedImageCount: imageCount,
                  maxImageCount: maxImages,
                },
                instagramData: inputData,
              }),
            },
            ...visualInputs,
          ],
        },
      ],
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "instagram_marketing_context",
          strict: true,
          schema: marketingContextJsonSchema,
        },
      },
      max_output_tokens: 12_000,
      store: false,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(120_000),
  });

  const payload = (await response.json().catch(() => ({}))) as OpenAIResponse;
  if (!response.ok) {
    throw new OpenAIAnalysisError(
      payload.error?.message || `OpenAI API request failed with ${response.status}.`,
      response.status,
    );
  }

  return parseStructuredAnalysis(payload);
}
