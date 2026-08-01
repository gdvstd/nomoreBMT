import {
  Agent,
  MaxTurnsExceededError,
  ModelBehaviorError,
  ModelRefusalError,
  generateTraceId,
  run,
  user,
  withTrace,
  type AgentInputItem,
} from "@openai/agents";
import { z } from "zod";

import {
  editorInputSchema,
  type EditorInput,
  type EditorInputGenerationAttempt,
  type EditorInputGenerationResult,
  type GenerateEditorInputRequest,
} from "./types";

const MAX_GENERATION_ATTEMPTS = 3;

const EDITOR_INPUT_AGENT_INSTRUCTIONS = `
You create a precise EditorInput for an Instagram carousel Editor Agent.

Use the selected idea, user request, brand context, actual user photos, and up
to two design-reference images. Return only the structured EditorInput.

Rules:
- The selected idea card is authoritative for slide count and narrative order,
  but not for unsupported factual claims. Rewrite any idea-card claim that is
  not evidenced by the user request, a photo description, or visible content.
  Create exactly one output slide for each selectedIdea.slides item, in order.
- design.description is a concrete, shared art direction. Explain which visible
  principles were learned from the reference images, then specify hierarchy,
  typography, palette, spacing rhythm, image treatment, overlays, and visual
  consistency. Do not merely say "follow the reference".
- Reference images are evidence for design only. Never assign them to a slide
  or instruct the Editor to place them in the result.
- Every slide uses exactly one supplied user photo. Choose the photo whose
  visible subject and provided description best support that slide's purpose.
  A photo may be reused when the story has more slides than photos, with a
  meaningfully different crop or treatment. Never invent an asset ID.
- sourceAssetId is the stable identity of the chosen user photo. imageUrl must
  be that same photo's supplied signed URL.
- imageDescription gives actionable natural-language direction for crop,
  focal subject, scale, placement, rotation if useful, color/tone, overlays,
  and how text may sit over or beside the photo. Prefer relational language
  over arbitrary pixel coordinates.
- text is null only for an intentionally text-free slide. Otherwise specify
  every visible text element. Each text description explains semantic role,
  hierarchy, placement, line breaking, alignment, overlay/background, and any
  intentional rotation. Keep copy concise enough to fit inside the card.
- slide.description explains the slide's purpose and the complete composition,
  including safe margins and how text and image work together.
- Ground every slide in the actual USER REQUEST and selectedIdea.slides item.
  Do not output generic phrases such as "place text harmoniously", "use a
  balanced crop", or "follow the reference". A production Editor must be able
  to build the card without making another creative decision.
- For every slide, make slide.description a concrete build brief containing:
  (1) the communication goal and relation to the previous/next slide,
  (2) the exact text elements that appear,
  (3) approximate relative regions such as upper fifth, left third, or lower
      quarter rather than unexplained pixel coordinates,
  (4) the layer stack from back to front,
  (5) the intended whitespace and safe area.
- For every imageDescription, name the visible subject that should remain in
  frame, the crop anchor, how much of the card the image occupies, and whether
  it is full-bleed or contained. Explicitly reserve a text-safe region. If text
  overlays the photo, require a contrast overlay between image and text.
- For every text description, state its role, approximate region, alignment,
  maximum line count, width relative to the card, and that it must remain above
  IMAGE_LAYER and any overlay. Use realistic type sizes for 1080x1350.
- The cover must contain a specific stopping hook. Body slides must each add a
  distinct fact, observation, or narrative beat supported by the request or
  image. Avoid repeating the title with slightly different wording.
- Before returning, silently check that all planned copy fits, every selected
  photo matches its slide, every text layer has contrast, and no instruction
  contradicts another field.
- Separate facts from visual inference. A subject visible in a photo may be
  described as an observation, but it does not prove a venue name, itinerary,
  recommendation, price, or relationship between locations. If the user gives
  only a short topic, build an observational photo story instead of inventing
  a guide or course. Never turn two unrelated uploads into a claimed route.
- Before writing the slides, silently make an evidence map: for each narrative
  claim, identify the exact user-request phrase, photo description, or visible
  photo detail that supports it. Remove or rewrite any unsupported claim.
- Reusing a photo is allowed only when the new slide has a clearly different
  crop and communication role. State that difference concretely; otherwise
  reduce repetition in the copy rather than pretending it is a new fact.
- Make geometry executable. When a photo is intended as the background, say
  "full-bleed: IMAGE_SLOT x=0, y=0, width=100%, height=100%" and name its crop
  anchor. When contained, state which region it occupies and require the rest
  of the card to be an intentional text or graphic region, not accidental
  empty canvas. Never describe a full-bleed image and a contained layout at
  the same time.
- For every full-bleed slide, imageDescription MUST begin with the exact phrase
  "full-bleed: IMAGE_SLOT x=0, y=0, width=100%, height=100%." This is an
  executable contract, not optional prose. For a contained image, begin with
  "contained:" and name its left/top/right/bottom region in percentages.
- Do not turn visible co-occurrence into preference or advice. A bowl and soup
  photographed together supports "함께 놓인 구성", not "함께 먹는 것이 더
  좋다". Use neutral observation when user intent is underspecified.
- Use the requested language. Do not invent locations, menu names, dates,
  prices, or claims absent from the request, descriptions, or visible images.
`;

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function candidateUserAssets(request: GenerateEditorInputRequest) {
  const selectedIds = new Set(request.selectedIdea.assetIds);
  const selected = request.userAssets.filter((asset) => selectedIds.has(asset.assetId));
  return selected.length ? selected : request.userAssets;
}

function buildInput(request: GenerateEditorInputRequest): AgentInputItem[] {
  const candidates = candidateUserAssets(request);
  const userManifest = candidates.map(
    ({ signedUrl: _signedUrl, ...asset }) => asset,
  );
  const referenceManifest = request.referenceAssets.map(
    ({ signedUrl: _signedUrl, ...asset }) => asset,
  );
  const content: Array<Record<string, unknown>> = [
    {
      type: "input_text",
      text: [
        "Create EditorInput for the selected carousel idea.",
        "\nUSER REQUEST\n",
        request.request,
        "\nSELECTED IDEA\n",
        safeJson(request.selectedIdea),
        `\nREQUIRED SLIDE COUNT\n${request.selectedIdea.slides.length}`,
        "\nMap output slide N to selectedIdea.slides[N]. Select the strongest supplied user photo for each slide; do not default to manifest order unless it supports the story.",
        request.brandContext
          ? `\nBRAND CONTEXT\n${safeJson(request.brandContext)}`
          : "",
        "\nUSER ASSET MANIFEST\n",
        safeJson(userManifest),
        "\nDESIGN REFERENCE MANIFEST\n",
        safeJson(referenceManifest),
        `\nOUTPUT LANGUAGE\n${request.language}`,
        "\nUse the exact assetId and signed URL shown together in the image labels below.",
      ].join("\n"),
    },
  ];

  for (const asset of candidates) {
    content.push({
      type: "input_text",
      text: `USER_PHOTO assetId=${asset.assetId} imageUrl=${asset.signedUrl} description=${asset.description || "not provided"}`,
    });
    content.push({
      type: "input_image",
      image: asset.signedUrl,
      detail: "high",
    });
  }
  for (const asset of request.referenceAssets) {
    content.push({
      type: "input_text",
      text: `DESIGN_REFERENCE assetId=${asset.assetId} imageUrl=${asset.signedUrl} sourceSlideIndex=${asset.sourceSlideIndex ?? "unknown"}; analyze it but never render it`,
    });
    content.push({
      type: "input_image",
      image: asset.signedUrl,
      detail: "high",
    });
  }

  return [user(content as Parameters<typeof user>[0])];
}

function normalizeAssetReferences(
  output: EditorInput,
  request: GenerateEditorInputRequest,
): EditorInput {
  const assetsById = new Map(
    candidateUserAssets(request).map((asset) => [asset.assetId, asset]),
  );
  const requiredSlideCount = request.selectedIdea.slides.length;
  if (output.slides.length !== requiredSlideCount) {
    throw new ModelBehaviorError(
      `EditorInput slide count ${output.slides.length} did not match selected idea count ${requiredSlideCount}.`,
    );
  }

  return {
    ...output,
    design: {
      ...output.design,
      referenceImageUrls: request.referenceAssets.map((asset) => asset.signedUrl),
    },
    slides: output.slides.map((slide, index) => {
      if (!slide.sourceAssetId) {
        throw new ModelBehaviorError(`Slide ${index + 1} did not select a sourceAssetId.`);
      }
      const asset = assetsById.get(slide.sourceAssetId);
      if (!asset) {
        throw new ModelBehaviorError(
          `Slide ${index + 1} selected unknown asset ${slide.sourceAssetId}.`,
        );
      }
      if (!slide.imageDescription) {
        throw new ModelBehaviorError(`Slide ${index + 1} omitted imageDescription.`);
      }
      return {
        ...slide,
        imageUrl: asset.signedUrl,
        sourceAssetId: asset.assetId,
      };
    }),
  };
}

function readStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number") return status;
  return readStatus((error as { cause?: unknown }).cause);
}

function isRetryableGenerationError(error: unknown) {
  if (error instanceof ModelRefusalError) return false;
  if (error instanceof MaxTurnsExceededError || error instanceof ModelBehaviorError) {
    return true;
  }
  const status = readStatus(error);
  if (status !== undefined) {
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  if (!(error instanceof Error)) return false;
  return ["AbortError", "TimeoutError", "APIConnectionError"].includes(error.name)
    || /timeout|network|fetch failed|connection/i.test(error.message);
}

export class EditorInputGenerationError extends Error {
  constructor(
    message: string,
    public readonly traceId: string,
    public readonly attempts: EditorInputGenerationAttempt[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EditorInputGenerationError";
  }
}

export async function generateEditorInput(
  request: GenerateEditorInputRequest,
): Promise<EditorInputGenerationResult> {
  const assets = candidateUserAssets(request);
  const assetIds = assets.map((asset) => asset.assetId) as [
    string,
    ...string[],
  ];
  const slideSchema = editorInputSchema.shape.slides.element.extend({
    sourceAssetId: z.enum(assetIds),
    imageUrl: z.string().url(),
    imageDescription: z.string().min(1),
  });
  const exactOutputSchema = editorInputSchema.extend({
    slides: slideSchema.array().length(request.selectedIdea.slides.length),
  });
  const agent = new Agent({
    name: "Editor Input Planner",
    model:
      process.env.OPENAI_REFERENCE_MODEL ??
      process.env.OPENAI_MODEL ??
      "gpt-5.4-mini",
    instructions: EDITOR_INPUT_AGENT_INSTRUCTIONS,
    outputType: exactOutputSchema,
    modelSettings: {
      reasoning: { summary: "concise" },
    },
  });
  const traceId = generateTraceId();
  const attempts: EditorInputGenerationAttempt[] = [];

  try {
    const editorInput = await withTrace(
      "BMT Editor Input Planner",
      async () => {
        for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt += 1) {
          const attemptRecord: EditorInputGenerationAttempt = {
            attempt,
            status: "started",
            message: `EditorInput 생성 시도 ${attempt}/${MAX_GENERATION_ATTEMPTS}`,
          };
          attempts.push(attemptRecord);
          try {
            const result = await run(agent, buildInput(request), { maxTurns: 1 });
            if (!result.finalOutput) {
              throw new ModelBehaviorError("EditorInput 생성 결과가 비어 있어요.");
            }
            const normalized = normalizeAssetReferences(
              exactOutputSchema.parse(result.finalOutput),
              request,
            );
            attemptRecord.status = "completed";
            attemptRecord.message = `${normalized.slides.length}장 EditorInput 생성 완료`;
            return normalized;
          } catch (error) {
            const retryable = isRetryableGenerationError(error);
            const finalAttempt = attempt === MAX_GENERATION_ATTEMPTS || !retryable;
            attemptRecord.status = finalAttempt ? "failed" : "retrying";
            attemptRecord.message = error instanceof Error
              ? error.message
              : String(error);
            if (finalAttempt) throw error;
          }
        }
        throw new Error("EditorInput 생성 시도 횟수를 초과했어요.");
      },
      {
        traceId,
        groupId: `editor-input:${request.taskId}`,
        metadata: {
          agent: "editor-input-planner",
          task_id: request.taskId,
          idea_id: request.selectedIdea.id,
          requested_slide_count: request.selectedIdea.slides.length,
          user_asset_count: assets.length,
          reference_count: request.referenceAssets.length,
        },
      },
    );
    return { editorInput, traceId, attempts };
  } catch (error) {
    throw new EditorInputGenerationError(
      error instanceof Error ? error.message : String(error),
      traceId,
      attempts,
      { cause: error },
    );
  }
}
