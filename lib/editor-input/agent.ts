import {
  Agent,
  run,
  user,
  type AgentInputItem,
} from "@openai/agents";

import {
  editorInputSchema,
  editorTextItemSchema,
  type EditorInput,
  type GenerateEditorInputRequest,
} from "./types";

const EDITOR_INPUT_AGENT_INSTRUCTIONS = `
You create a precise EditorInput for an Instagram carousel Editor Agent.

Use the selected idea, user request, brand context, actual user photos, and up
to two design-reference images. Return only the structured EditorInput.

Rules:
- design.description contains rules shared by every slide: layout system,
  hierarchy, typography, palette, spacing, image treatment, tone, and visual
  consistency.
- design.referenceImageUrls contains only supplied design-reference URLs, in
  supplied order, with at most two values.
- Reference images are evidence for design only. Never assign them to a
  slide.imageUrl and never instruct the Editor to place them in the result.
- slides.length must equal supplied user-photo count + 1.
- Slide 1 is the cover and uses the first supplied user photo as its only
  image.
- Starting at slide 2, slide N+1 must use user photo N in supplied order.
- Every slide has exactly one non-null imageUrl. Never skip, reorder, combine,
  or substitute user photos.
- text is null only for an intentionally text-free slide. Otherwise specify
  every visible text element with content, point size, color, and optional font.
- description naturally explains text positions, composition, style, image
  size, crop, location, tone, hierarchy, and whitespace for that slide.
- Do not invent locations, menu names, dates, prices, or claims absent from the
  request, photo descriptions, or visible images.
- Write instructions and copy in the requested language.
`;

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildInput(request: GenerateEditorInputRequest): AgentInputItem[] {
  const userManifest = request.userAssets.map(
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
        `\nREQUIRED SLIDE COUNT\n${request.userAssets.length + 1}`,
        "\nCreate one cover using user photo 1, then one body slide per user photo. Body slide N+1 must use only user photo N in manifest order.",
        request.brandContext
          ? `\nBRAND CONTEXT\n${safeJson(request.brandContext)}`
          : "",
        "\nUSER ASSET MANIFEST\n",
        safeJson(userManifest),
        "\nDESIGN REFERENCE MANIFEST\n",
        safeJson(referenceManifest),
        `\nOUTPUT LANGUAGE\n${request.language}`,
        "\nUse the exact signed URLs shown in the image labels below.",
      ].join("\n"),
    },
  ];

  for (const asset of request.userAssets) {
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
      text: `DESIGN_REFERENCE assetId=${asset.assetId} imageUrl=${asset.signedUrl} sourceSlideIndex=${asset.sourceSlideIndex ?? "unknown"}; never render this image`,
    });
    content.push({
      type: "input_image",
      image: asset.signedUrl,
      detail: "high",
    });
  }

  return [user(content as Parameters<typeof user>[0])];
}

function verifyAssetUrls(
  output: EditorInput,
  request: GenerateEditorInputRequest,
) {
  const requiredSlideCount = request.userAssets.length + 1;
  if (output.slides.length !== requiredSlideCount) {
    throw new Error(
      `EditorInput slide 수(${output.slides.length})가 필수 slide 수(${requiredSlideCount})와 달라요.`,
    );
  }
  const normalizedSlides = output.slides.map((slide, index) => {
    const requiredAsset =
      index === 0 ? request.userAssets[0] : request.userAssets[index - 1];
    return {
      ...slide,
      imageUrl: requiredAsset.signedUrl,
      description: index === 0
        ? `${slide.description} 표지는 첫 번째 업로드 사진 한 장만 사용한다.`
        : `${slide.description} 업로드 ${index}번째 사진 한 장만 사용하며 다른 사진을 함께 배치하지 않는다.`,
    };
  });
  const referenceImageUrls = request.referenceAssets.map(
    (asset) => asset.signedUrl,
  );
  return {
    ...output,
    slides: normalizedSlides,
    design: {
      ...output.design,
      referenceImageUrls,
    },
  };
}

export async function generateEditorInput(
  request: GenerateEditorInputRequest,
): Promise<EditorInput> {
  const plannerSlideSchema = editorInputSchema.shape.slides.element.extend({
    text: editorTextItemSchema
      .array()
      .or(editorTextItemSchema)
      .nullable(),
  });
  const exactOutputSchema = editorInputSchema.extend({
    slides: plannerSlideSchema.array().length(
      request.userAssets.length + 1,
    ),
  });
  const agent = new Agent({
    name: "Editor Input Planner",
    model:
      process.env.OPENAI_REFERENCE_MODEL ??
      process.env.OPENAI_MODEL ??
      "gpt-5.4-mini",
    instructions: EDITOR_INPUT_AGENT_INSTRUCTIONS,
    outputType: exactOutputSchema,
  });
  const result = await run(agent, buildInput(request), { maxTurns: 1 });
  if (!result.finalOutput) {
    throw new Error("EditorInput 생성 결과가 비어 있어요.");
  }
  const normalizedOutput: EditorInput = {
    ...result.finalOutput,
    slides: result.finalOutput.slides.map((slide) => ({
      ...slide,
      text:
        slide.text === null
          ? null
          : Array.isArray(slide.text)
            ? slide.text
            : [slide.text],
    })),
  };
  return verifyAssetUrls(normalizedOutput, request);
}
