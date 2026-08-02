import {
  Agent,
  generateTraceId,
  run,
  user,
  withTrace,
  type AgentInputItem,
  type Tool,
} from "@openai/agents";

import {
  createResearchCapture,
  createScoutTool,
  marketerReferencesFromContext,
} from "./research-tool";
import {
  marketerModelOutputSchema,
  type MarketerAgentInput,
  type MarketerAgentEvent,
  type MarketerAgentOutput,
  type MarketerComplianceCheck,
  type MarketerModelOutput,
  type MarketerReference,
} from "./types";

export const MARKETER_AGENT_INSTRUCTIONS = `
You are the Marketing Agent for a personal-brand content platform.

From the user's brief, brand direction, and supplied photos, produce exactly two
distinct, selectable Instagram carousel idea cards. Each card must include a
fully-authored slide plan so it can go straight to the Editor Agent with no
further planning. Do not ask follow-up questions or invent a third option.

Workflow:
1. Read the user's request, brand direction, and every supplied photo. Note the
   subjects, moods, colors, and possible visual sequences you can actually use.
2. Decide topic, purpose, and searchTerms, then call scout_instagram_references
   EXACTLY ONCE. topic is the specific research subject; purpose is what you want
   to learn (hook, information order, crop, typography); searchTerms are Korean
   phrases likely to surface similar public carousels. Region, carousel format,
   recency, and reference count are fixed server-side — do not try to set them.
   Never call the tool a second time, even if few references return.
3. Integrate the tool result. Use its references, patterns, and editorContext to
   answer: which hooks recur for this topic; how saveable carousels order their
   information; where and how photos are cropped and placed; how text sits over
   or beside images; what to adapt to this brand; and what NOT to copy.
4. If the tool returns no references (or fails), proceed from the user's photos
   and brand direction alone. Do not fabricate references or metrics.

Design references are evidence ONLY. Derive reusable layout, hierarchy, color,
typography, spacing, and image-treatment principles. Never plan to place a
reference image in the finished post. When a reference informs a slide, record
it in that slide's referenceInspirations with the exact referenceId from the
tool result, what you borrowed, and how you adapted it.

The two ideas must be genuinely different editorial angles — different hook,
narrative order, photo selection, and visual rhythm — not a reworded title. One
may be practical/information-led, the other emotional/personality-led when the
material supports it.

Buildable design vocabulary (design guideline for what the editor can compose):
the editor can only place the user photo (full_bleed or contained), one optional
full-slide dark overlay for legibility, thin opaque lines, and text. It cannot
build badges, circles, stars, stickers, translucent text panels, or arbitrary
shapes. Do not describe those in designDirection, intent, or imageIntent.
Express hierarchy through crop, whitespace, typography, text color, the optional
dark overlay, and opaque lines. Each card uses one user photo (by sourceAssetId;
a photo may repeat across cards), every text element sits above the image, and
reference images are never placed in the post.

Author each card:
- id, label, title, hook, description, format, accent ("coral" or "blue").
- assetIds: the exact user photo IDs this card uses (from the ASSET MANIFEST).
- referenceIds: up to two referenceIds (from the tool result) this card draws on.
- designDirection: concrete shared art direction for the whole card set —
  hierarchy, typography, palette, spacing rhythm, image treatment, overlays.
  Do not merely say "follow the reference".
- slides: follow the slide-count guideline below.

Slide count & hooking (guideline, not a rigid formula):
- Default to one slide per user photo, used once in the user's upload order.
  With N photos, aim for N slides where the first photo's slide is the cover.
- You may add at most two extra framing slides — one opening at the very front
  and/or one closing at the very back — ONLY when they genuinely add value, so
  the total is between N and N+2. Never pad with filler.
  - Opening: add only when there is a strong, scroll-stopping hook worth its own
    cover slide. It reuses the first photo with a distinct cover crop.
  - Closing: add only when there is an important wrap-up or CTA worth its own
    slide. It reuses the last photo with a distinct crop.
- The cover is the first slide (photo 1's slide, or the added opening). Give it
  the single strongest hook/title as the largest text so a reader grasps the
  whole topic from the cover alone; keep its hierarchy clearly above body slides.
- Body slides each carry a distinct fact, observation, or beat and do not repeat
  the cover wording. A closing slide, if present, summarizes or gives a CTA.
- Every slide still uses exactly one user photo via sourceAssetId; a photo may
  repeat only for an opening/closing framing slide, never on ordinary body
  slides. Never place two photos on one slide and never invent a cover image.

For EACH slide author:
- sourceAssetId: the stable id of the user photo for this slide. It MUST be one
  of the ASSET MANIFEST assetId values. A photo may be reused with a meaningfully
  different crop; never invent an id.
- imageTreatment: "full_bleed" or "contained". Choose deliberately.
- text: visible text elements, each with a role (hook|title|body|caption|cta|
  label) and concise content in the requested language. null only for an
  intentionally text-free slide. Do NOT specify size or color.
- intent: this slide's communication goal and its relation to the neighbours.
- imageIntent: crop anchor, focal subject to keep in frame, and text-safe region.
- referenceInspirations: up to two, each { referenceId, borrowed, adaptedHow }.

Evidence discipline:
- Do not claim facts absent from the brief or not visible in the photos: no
  invented venue names, menus, prices, dates, itineraries, or recommendations.
- Separate observation from inference. Keep copy in the requested language and
  preserve the brand direction.

Return exactly two cards. The contrast between them must be obvious.
`;

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildTextPrompt(input: MarketerAgentInput) {
  const manifest = input.assets.items.map(({ url: _url, ...asset }) => asset);

  return [
    "Generate exactly two idea cards, each with a complete slide plan.",
    "\nUSER REQUEST\n",
    input.request,
    "\nBRAND DIRECTION\n",
    input.brandDirection || "No additional brand direction was provided.",
    input.brandContext
      ? `\nSTRUCTURED ONBOARDING CONTEXT\n${safeJson(input.brandContext)}`
      : "",
    "\nTARGET\n",
    `${input.target}; output language: ${input.language}`,
    "\nASSET MANIFEST (the images follow this text)\n",
    safeJson({ assetSetId: input.assets.assetSetId, items: manifest }),
    "\nUse the assetId values exactly for every slide.sourceAssetId and card.assetIds.\n",
    "\nFirst decide topic/purpose/searchTerms and call scout_instagram_references once, then author two cards with complete slide plans.\n",
  ].join("\n");
}

/**
 * Build one multimodal user message. Assets without a URL/file ID remain in
 * the manifest, while resolvable assets are also presented to the model as
 * image inputs in the same inference. Design references are fetched by the
 * scout tool, not passed here.
 */
export function buildMarketerAgentInput(input: MarketerAgentInput): AgentInputItem[] {
  const content: Array<Record<string, unknown>> = [
    { type: "input_text", text: buildTextPrompt(input) },
  ];

  for (const asset of input.assets.items) {
    if (asset.url) {
      content.push({ type: "input_image", image: asset.url, detail: "high" });
    } else if (asset.fileId) {
      content.push({ type: "input_image", image: { id: asset.fileId }, detail: "high" });
    }
  }

  return [user(content as Parameters<typeof user>[0])];
}

/** Verify the marketer followed its assigned procedure, for display + audit. */
function buildCompliance(
  ideas: MarketerAgentOutput["ideas"],
  references: MarketerReference[],
  scoutCalled: boolean,
  hasScoutContext: boolean,
): MarketerComplianceCheck[] {
  const [first, second] = ideas;
  const cardsDistinct =
    ideas.length === 2 &&
    first.hook.trim() !== second.hook.trim() &&
    (first.slides.length !== second.slides.length ||
      first.slides[0]?.sourceAssetId !== second.slides[0]?.sourceAssetId ||
      first.assetIds.join(",") !== second.assetIds.join(","));
  const everySlideComplete = ideas.every(
    (idea) =>
      idea.slides.length >= 2 &&
      idea.slides.length <= 10 &&
      idea.slides.every(
        (slide) =>
          slide.sourceAssetId &&
          slide.imageTreatment &&
          slide.intent.trim() &&
          slide.imageIntent.trim(),
      ),
  );
  const referencesCited =
    references.length === 0 ||
    ideas.some(
      (idea) =>
        idea.referenceIds.length > 0 ||
        idea.slides.some((slide) => slide.referenceInspirations.length > 0),
    );

  return [
    {
      id: "scout-once",
      label: "레퍼런스 조사 1회 실행",
      passed: scoutCalled,
      detail: scoutCalled
        ? "scout_instagram_references를 1회 호출했어요."
        : "레퍼런스 조사 도구를 호출하지 않았어요.",
    },
    {
      id: "references-verified",
      label: "검증된 레퍼런스 확보",
      passed: hasScoutContext && references.length > 0,
      detail: references.length
        ? `${references.length}개의 공개 Instagram 레퍼런스를 확보했어요.`
        : "검증된 레퍼런스가 없어 사용자 사진과 브랜드 근거로만 진행했어요.",
    },
    {
      id: "two-distinct-cards",
      label: "서로 다른 두 방향 생성",
      passed: cardsDistinct,
      detail: cardsDistinct
        ? "hook·슬라이드 구성·사진 선택이 다른 두 카드를 만들었어요."
        : "두 카드의 차별성이 부족해요.",
    },
    {
      id: "complete-slide-plans",
      label: "카드별 완성 슬라이드 플랜",
      passed: everySlideComplete,
      detail: everySlideComplete
        ? `각 카드가 2~10장 슬라이드에 sourceAssetId·imageTreatment·intent를 모두 채웠어요 (${ideas.map((idea) => idea.slides.length).join(" / ")}장).`
        : "일부 슬라이드에 필수 설계 항목이 빠졌어요.",
    },
    {
      id: "references-cited",
      label: "레퍼런스 근거 인용",
      passed: referencesCited,
      detail:
        references.length === 0
          ? "인용할 레퍼런스가 없어요."
          : referencesCited
            ? "슬라이드 설계에 레퍼런스에서 가져온 요소를 명시했어요."
            : "레퍼런스를 확보했지만 카드에 근거로 인용하지 않았어요.",
    },
  ];
}

/**
 * Attach the trustworthy references from the scout result and clamp every
 * model-authored id to a real asset/reference. The static outputType cannot
 * enum runtime ids, so this is where sourceAssetId, assetIds, referenceIds, and
 * referenceInspirations are validated and repaired. A procedure-compliance
 * report is computed from the normalized result.
 */
function normalizeOutput(
  modelOutput: MarketerModelOutput,
  input: MarketerAgentInput,
  references: MarketerReference[],
  scoutCalled: boolean,
  hasScoutContext: boolean,
): MarketerAgentOutput {
  const assetsById = new Map(input.assets.items.map((asset) => [asset.assetId, asset]));
  const allAssetIds = input.assets.items.map((asset) => asset.assetId);
  const fallbackAssetId = allAssetIds[0];
  const referenceIds = new Set(references.map((reference) => reference.id));

  const ideas = modelOutput.ideas.map((idea) => {
    const selectedIds = [...new Set(idea.assetIds)].filter((assetId) =>
      assetsById.has(assetId),
    );
    const safeAssetIds = selectedIds.length ? selectedIds : allAssetIds;
    const safeReferenceIds = [...new Set(idea.referenceIds)]
      .filter((referenceId) => referenceIds.has(referenceId))
      .slice(0, 2);

    return {
      ...idea,
      assetIds: safeAssetIds,
      assets: safeAssetIds.map(
        (assetId, index) => assetsById.get(assetId)?.name || `사진 ${index + 1}`,
      ),
      referenceIds: safeReferenceIds,
      slides: idea.slides.map((slide) => ({
        ...slide,
        sourceAssetId: assetsById.has(slide.sourceAssetId)
          ? slide.sourceAssetId
          : fallbackAssetId,
        referenceInspirations: slide.referenceInspirations
          .filter((inspiration) => referenceIds.has(inspiration.referenceId))
          .slice(0, 2),
      })),
    };
  });

  return {
    ...modelOutput,
    references,
    ideas,
    compliance: buildCompliance(ideas, references, scoutCalled, hasScoutContext),
  };
}

export function createMarketerAgent(options?: { model?: string; tools?: Tool[] }) {
  return new Agent({
    name: "Marketing Agent",
    model: options?.model ?? process.env.OPENAI_REFERENCE_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
    instructions: MARKETER_AGENT_INSTRUCTIONS,
    tools: options?.tools ?? [],
    outputType: marketerModelOutputSchema,
  });
}

export type MarketerAgentOptions = {
  model?: string;
  runId?: string;
  traceId?: string;
  groupId?: string;
  onEvent?: (event: MarketerAgentEvent) => void;
};

/** One streamed run() call: the model scouts references once, then authors two cards. */
export async function runMarketerAgent(
  input: MarketerAgentInput,
  options: MarketerAgentOptions = {},
): Promise<MarketerAgentOutput> {
  const capture = createResearchCapture();
  const agent = createMarketerAgent({
    model: options.model,
    tools: [createScoutTool(capture, options.onEvent)],
  });
  const runId = options.runId ?? crypto.randomUUID();
  const traceId = options.traceId ?? generateTraceId();
  const groupId = options.groupId ?? `marketer-task:${input.taskId}`;
  const traceMetadata = {
    agent: "marketer",
    run_id: runId,
    task_id: input.taskId,
    asset_set_id: input.assets.assetSetId,
  };

  options.onEvent?.({
    type: "status",
    status: "started",
    message: "마케팅 에이전트가 사진과 브랜드 컨텍스트를 전달받았어요.",
    runId,
    traceId,
  });

  const result = await withTrace(
    "BMT Marketing Agent",
    async () => {
      const stream = await run(agent, buildMarketerAgentInput(input), { stream: true });
      options.onEvent?.({
        type: "status",
        status: "streaming",
        message: "마케팅 에이전트 실행 시작 · 조사 도구 호출을 준비 중이에요.",
        runId,
        traceId,
      });

      // Tool activity is emitted by the scout tool itself with real args and a
      // real result summary; here we only forward the model's own output text.
      for await (const event of stream) {
        if (event.type === "raw_model_stream_event" && event.data.type === "output_text_delta") {
          options.onEvent?.({ type: "assistant_delta", text: event.data.delta });
        }
      }

      await stream.completed;
      return stream;
    },
    { traceId, groupId, metadata: traceMetadata },
  );
  if (!result.finalOutput) throw new Error("Marketing agent completed without structured output");
  const references = marketerReferencesFromContext(capture.context);
  const normalizedOutput = normalizeOutput(
    result.finalOutput,
    input,
    references,
    capture.called,
    capture.context !== null,
  );
  options.onEvent?.({ type: "result", output: normalizedOutput });
  options.onEvent?.({
    type: "status",
    status: "completed",
    message: "두 가지 콘텐츠 방향과 슬라이드 플랜을 완성했어요.",
    runId,
    traceId,
  });
  return normalizedOutput;
}
