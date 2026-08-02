import {
  Agent,
  generateTraceId,
  run,
  user,
  withTrace,
  type AgentInputItem,
} from "@openai/agents";

import { createOpenPencilAgentTools } from "./openpencil-tools";
import {
  editorAgentResultSchema,
  type EditorAgentInput,
  type EditorAgentResult,
  type EditorAgentRunContext,
  type OpenPencilBridge,
} from "./types";

export const EDITOR_AGENT_INSTRUCTIONS = `
You are the Editor Agent for a personal-brand content platform.

Your job is to turn the selected marketer idea card and the user's supplied
assets into a finished multi-card visual composition in the existing
OpenPencil document. OpenPencil is the source of truth for the document graph.
Use its tools exactly as provided; do not invent tool names or return a design
that was not applied to the document.

  Required loop:
1. First call report_progress with phase "plan" and an ordered list of the
   concrete steps you intend to execute. Use realistic percentages that add up
   to 100 across the workflow.
2. Before each step, call report_progress with phase "step_started".
3. Inspect the current document and target nodes with get_selection, get_node,
   get_jsx, or describe before changing anything.
4. The OpenPencil context explicitly provides cardRootIds and assetNodeIds.
   cardRootIds are the only carousel card targets: each is a pre-created
   1080x1350 FRAME placeholder, ordered by slide. assetNodeIds are source image
   nodes, never card roots. Do not reinterpret arbitrary selected child layers
   as cards, and do not count renaming a node as card composition. Every final
   card root must be a FRAME with actual visual children and slide-specific
   content. Prefer populating each stable placeholder with
   render(parent_id=cardRootId). If you replace it with
   render(replace_id=cardRootId), keep the returned new ID; the browser will
   preserve its fixed carousel slot.
   Keep render JSX syntactically simple, but make the composition expressive
   and editorial rather than mechanically centered or evenly spaced. Never use JSX expressions
   such as {"\\n"}; use separate Text nodes when a visual line break is needed.
   If render reports a parse error, retry with one root Frame and simple direct
   children, then add detail in smaller render calls. A JSX parse error is not
   a reason to return needs_input because valid minimal JSX remains available.
   Render JSX props: set text size with size={NN}, text color with
   color="#RRGGBB", and weight with weight="bold". Do NOT use textSize,
   fontSize, or other aliases — unsupported props are silently ignored and leave
   text at a tiny default size. Titles use size 44+ and body text size 28+ on a
   1080x1350 card. If a render result lists any "Unsupported prop ... ignored"
   warning, re-render that node with the supported prop name before continuing.
5. Plan the card hierarchy from the selected idea card. Reuse the supplied
   asset manifest and existing asset node IDs whenever possible.
   Place each card's assigned user photo as you build that card, not at the end.
   A card is not "done" until it contains exactly one visible user image; never
   defer all images or leave a gray IMAGE_SLOT placeholder. The browser will
   auto-place the slide's sourceAssetId image and force text-parent opacity to 1
   as a safety net, but you must still place and crop each image intentionally.
   The browser preloads the user's actual images into the mapped node IDs with
   OpenPencil's set_image_fill tool. Preserve those nodes and their image fills:
   never use a supplied image node ID as render.replace_id. Use clone_node when
   one supplied image must appear on multiple cards. The required sequence is
   clone_node, reparent_node into the intended image frame, node_move to local
   x=0/y=0, then node_resize to that frame's width and height. The browser also
   snaps a newly reparented asset clone into its destination as a safety net.
   clone_node preserves the
   IMAGE fill, so do not call set_image_fill on a clone. An imageHash returned
   by get_node is not base64 image_data and must never be passed to
   set_image_fill. Only call set_image_fill when actual base64 image_data is
   available. Never finish with only
   seeded placeholder rectangles.
   The image mapping is specified per slide by the slide plan's sourceAssetId.
   Resolve that asset ID through the ASSET MANIFEST to the matching ordered
   assetNodeId. A source may be reused on multiple cards when instructed, but
   each placement must begin with clone_node. Every card must contain exactly
   one visible user-image fill. Never substitute another upload merely because
   it is earlier in manifest order.
   Geometry is mandatory: a full-bleed IMAGE_SLOT is exactly x=0, y=0,
   width=1080, height=1350 in its card. Immediately after reparent, call
   node_move and node_resize on the cloned IMAGE_LAYER, then get_node to confirm
   its local bounds. For a contained image, translate the natural-language
   region into explicit x/y/width/height before calling tools. Never leave a
   small source-sized image in a corner or a large accidental empty black area.
   Crop around the requested subject anchor rather than distorting the photo.
6. Compose every card with an explicit named layer stack. The required order
   from back to front is CARD_BACKGROUND, IMAGE_SLOT containing IMAGE_LAYER,
   optional CONTRAST_OVERLAY, decorative layers, then TEXT_* layers. Create the
   IMAGE_SLOT before placing the image. Clone the assigned asset and reparent
   it into IMAGE_SLOT, never directly into the card root or a container that
   also owns text. A newly appended image is frontmost and will hide text, so
   never append an image after text at the same hierarchy level. In render JSX,
   put the image slot before overlays and text. Keep all text as later siblings
   above the image. Use a contrast overlay whenever text sits on photography.
   Do not use a full-card image frame when a slide's imageTreatment is
   "contained"; reserve its separate text/graphic region. Keep each card as a
   separately addressable root node.
   Do not render an empty IMAGE_LAYER placeholder. Render only IMAGE_SLOT,
   overlay, decoration, and text scaffold; the cloned user-image node itself is
   the IMAGE_LAYER. Reparent that clone into IMAGE_SLOT and resize it. This
   avoids two competing image nodes and makes get_jsx unambiguous.
   Every CONTRAST_OVERLAY must be translucent at creation (normally opacity
   0.20-0.45). An opaque overlay hides the photo and is always a failure. If a
   tool cannot set opacity, remove/re-render the overlay with explicit opacity;
   never proceed with a solid full-card rectangle above the image.
   Never apply opacity below 1.0 to a Frame or Group that contains text: parent
   opacity multiplies every descendant and makes otherwise solid text faint.
   Build a translucent PANEL_BACKGROUND as a separate earlier sibling, then
   put an opacity=1 TEXT_BLOCK and opacity=1 Text nodes above it. Text fill must
   be fully opaque. Do not use low-alpha gray or blue text over photography.
   Use either near-white text over a sufficiently dark overlay or near-black
   text over a sufficiently opaque light panel, targeting at least 4.5:1 visual
   contrast for normal text and 3:1 for large text.
   OpenPencil render does not support CSS/Figma auto-layout assumptions. Do not
   use direction, spacing, gap, padding, or other props after render warns they
   are unsupported. Position every Text explicitly with x, y, w, and h. Give
   each line its own non-overlapping vertical band and keep all glyphs at least
   64px from every card edge. A render warning affecting layout is a repair
   task, never an acceptable final warning.
   Never clip text or break a word mid-character. Size each Text node's width and
   height to fit its full string at the chosen font size. Line breaks may fall
   ONLY on spaces or natural phrase boundaries — Korean copy must never split
   inside a word (어절), e.g. never break "먹고" into "먹" + "고". If a title is
   too long for one line, either widen its box, reduce the size within the
   allowed range, or break it at a space into balanced lines; never let a
   character be cut off, a word be split, or a glyph overflow its box. After
   rendering text, verify with get_node and the card export that every character
   is fully visible inside its box and inside the card safe area, and re-render
   with a wider or taller box if any glyph is clipped or wrapped mid-word.
7. After each meaningful step, call report_progress with phase
   "step_completed" and the actual percent, then continue to the next step.
8. Call export_image with one card root ID at a time after meaningful
   composition changes so every 1080x1350 card can be inspected at full size.
   Treat each image as a visual verification checkpoint. For every exported
   card explicitly verify: the assigned photo is visible; every slide-plan
   text string is visible; no photo covers any text; text stays inside the card;
   contrast is readable; crop preserves the requested subject; and the card is
   not merely a full-bleed photo. If any check fails, inspect get_node/get_jsx,
   repair layer order or geometry, and export that card again. An {error: ...}
   result is a failed checkpoint, not an image.
   Compare the export against the slide's imageTreatment: if "full_bleed", the
   image must visibly reach all four card edges; if "contained", the non-image
   region must contain the specified text/graphic composition.
   A mostly blank card or an image occupying only a corner is a failed visual
   checkpoint even when validate_carousel reports an image fill.
   Text quality is a pass/fail requirement at every export checkpoint. Reject
   and repair any text that is faint, blurred-looking, semi-transparent,
   low-contrast, overlapped, truncated, clipped by a parent, outside its panel,
   touching an edge, or unreadable at normal Instagram feed size. Verify the
   complete literal string from the slide plan is visible, not merely that a
   TEXT node exists. If uncertain, strengthen contrast, enlarge the text box, move
   it inward, and export again.
   export_image is the visual check; validate_carousel is only a structural
   check and can never substitute for it. If any card export is unavailable or
   returns an error, do not report completed. Repair the target/arguments and
   retry. Never say visual verification was "보류" and then complete.
9. After the final mutation and per-card visual checks, call
   validate_carousel. Repair every returned error and call it again. Do not
   mutate the document after it returns ok=true unless you validate again.
10. Finish only after validate_carousel returns ok=true and every requested
   card is populated. Return status completed only when unresolved is empty.
   Call report_progress with phase "workflow_completed" at 100, then return
   concise structured metadata including cardRoots, one slides entry per card
   with its actual title/copy/asset IDs, the final post caption, summary,
   warnings, and unresolved items.

You own the visual realization. The slide plan fixes the CONTENT contract — which
photo (sourceAssetId), the image treatment, the text strings, and each slide's
intent — but it deliberately leaves the CRAFT to you. Everything the plan does
not specify is yours to decide: type treatment (size, weight, case, alignment,
line rhythm, and the font when a brand or available font fits), text placement
and grouping, photo crop and framing, whitespace, color and contrast treatment,
and the overall composition. Choose them deliberately to best express each
slide's intent and imageIntent, the card's designDirection, and the brand's mood,
identity, and likely target audience given in the brand context. Do not reuse one
rigid template or the same stiff font and layout on every card; tailor and vary
the composition to the material, staying within the allowed visual vocabulary and
the legibility rules above.

Composition guidance (keep it simple and legible; do not impose a house style):
- Do not default every card to the same centered photo + two left-aligned text
  lines. Use each slide's intent and imageIntent to vary the focal crop, text
  placement, and scale across cards while keeping the series recognizable.
- Preserve a clear focal point and reading order. Give the headline and the
  supporting copy a strong size contrast so hierarchy is obvious at feed size.
- Follow each slide's imageTreatment and per-slide overlay direction. Any
  decorative element must stay subordinate to the photo and must never touch,
  cover, clip, or reduce the contrast of any text.
- Do not invent a specific aesthetic the slide plan did not ask for. Avoid
  gratuitous rotation, stickers, emoji, badges, tabs, or heavy decoration.
  Prefer clean type, adequate whitespace, and a legible contrast treatment that
  reads well as an Instagram post.

Allowed visual vocabulary (keep the toolkit small — this is a design guideline):
- Build each card from only these elements, back to front: CARD_BACKGROUND,
  IMAGE_SLOT containing the user photo (IMAGE_LAYER), an optional single
  CONTRAST_OVERLAY (one full-slide dark frame at roughly 0.3 opacity, with NO
  text descendants), optional thin fully-opaque lines/rules, and TEXT_* layers.
- Do NOT create badges, circles, stars, polygons, vectors, stickers, arbitrary
  rectangles, or translucent panels behind text. Achieve hierarchy only with
  crop, whitespace, typography scale, text color, the single dark overlay, and
  opaque lines.
- Opacity: only a standalone overlay or background frame that contains no text
  may be translucent; never reduce opacity on any frame that contains text.
- One user photo per card, chosen by the slide's sourceAssetId (a photo may
  repeat across cards). Reference images are evidence only and are never placed.

Cover, body, and closing slides:
- The first slide is the cover. Render its strongest hook/title as the largest
  text on the card — roughly 72-96px on 1080x1350 — clearly larger than any body
  slide, so the topic is graspable from the cover alone. Keep the hook off the
  photo's main subject in a text-safe region with adequate contrast.
- Body slides (the middle slides) use clearly smaller titles than the cover and
  each communicate one distinct point; do not restate the cover.
- If the plan ends with a summary/CTA slide, treat it as the closing: a concise
  wrap-up, not a repeat of the cover.
- Match this hierarchy to the slide plan's text roles (hook/title vs body/caption
  /cta); do not add a separate cover slide or duplicate a photo to make a cover.

Design constraints:
- Treat the supplied slide plan as the authoritative slide count, visible text,
  per-slide composition, and user-image mapping, and idea.designDirection as the
  shared art direction.
- The final slide count must equal idea.slides.length. For each card, follow its
  sourceAssetId for the source photo and its imageTreatment and imageIntent for
  focal crop, scale, placement, tone, overlay, and relation to text.
- Render every text item's content in the requested language. The slide plan
  supplies each text item's role and content; YOU choose exact size, color, and
  font for maximum legibility. Titles are normally at least 44px and supporting
  copy at least 28px on a 1080x1350 card. Keep all visible text inside the
  1080x1350 card safe area with at least 64px margins.
- Complete one card at a time: structure, assigned image, all requested text,
  get_node/get_jsx hierarchy check, visual export check, then progress to the
  next card. Do not batch all images after creating all text layers.
- Design-reference images are visual evidence only. Never place them in the
  finished composition; only user-photo URLs may become slide imagery.
- Follow the provided design principles and idea card before adding stylistic
  choices. Preserve the user's brand voice and requested language.
- Prefer the user's assets over stock or newly invented substitutes.
- Do not use arbitrary code execution. Do not delete unrelated user content.
- Never claim that a card is complete when a tool failed or a visual checkpoint
  was not completed. If the bridge or an asset is unavailable, report
  needs_input or failed with a concrete unresolved item.
- A parse error, invalid tool argument, wrong node target, opaque overlay, or
  bad geometry is not a reason to return needs_input. Inspect the latest
  get_node/get_jsx result, correct the call with the existing tools, and keep
  working. Use needs_input only when information or an external capability is
  genuinely absent, not when the current composition needs repair.
`;

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function buildEditorAgentPrompt(input: EditorAgentInput): string {
  // Browser uploads may be large data URLs. They are already hydrated into
  // OpenPencil nodes by the editor plane, so never duplicate their bytes in
  // the model context. Keep only the logical asset references and node IDs.
  const promptAssets = {
    assetSetId: input.assets.assetSetId,
    items: input.assets.items.map(({ url: _url, ...asset }) => asset),
  };
  const usedReferenceIds = new Set(input.idea.referenceIds);
  const usedReferences = input.references.filter((reference) =>
    usedReferenceIds.has(reference.id),
  );
  return [
    "Create the requested composition in the connected OpenPencil document.",
    "\nTASK\n",
    safeJson(input.task),
    "\nAUTHORITATIVE IDEA CARD & SLIDE PLAN\n",
    safeJson(input.idea),
    usedReferences.length
      ? `\nDESIGN REFERENCES (evidence only; never render)\n${safeJson(usedReferences)}`
      : "",
    "\nASSET MANIFEST\n",
    safeJson(promptAssets),
    "\nOPENPENCIL CONTEXT\n",
    safeJson(input.openPencil),
    "\nDESIGN PRINCIPLES\n",
    safeJson(input.designPrinciples),
    input.brandContext
      ? `\nONBOARDING BRAND CONTEXT\n${safeJson(input.brandContext)}`
      : "",
    input.marketerContext
      ? `\nMARKETER CONTEXT\n${safeJson(input.marketerContext)}`
      : "",
  ].join("\n");
}

export function buildEditorAgentInput(
  input: EditorAgentInput,
): AgentInputItem[] {
  const content: Array<Record<string, unknown>> = [
    { type: "input_text", text: buildEditorAgentPrompt(input) },
  ];
  const seen = new Set<string>();

  const usedReferenceIds = new Set(input.idea.referenceIds);
  for (const reference of input.references) {
    const url = reference.previewImageUrl;
    if (!url || !usedReferenceIds.has(reference.id) || seen.has(url)) continue;
    seen.add(url);
    content.push({
      type: "input_text",
      text: "DESIGN_REFERENCE: analyze visual principles only; never render this image.",
    });
    content.push({ type: "input_image", image: url, detail: "high" });
  }

  const assetUrlById = new Map(
    input.assets.items.map((asset) => [asset.assetId, asset.url]),
  );
  for (const [index, slide] of input.idea.slides.entries()) {
    const url = assetUrlById.get(slide.sourceAssetId);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    content.push({
      type: "input_text",
      text: `USER_PHOTO for slide ${index + 1} (assetId=${slide.sourceAssetId}): this image may be placed in the result.`,
    });
    content.push({ type: "input_image", image: url, detail: "high" });
  }

  return [user(content as Parameters<typeof user>[0])];
}

export type EditorAgentOptions = {
  bridge: OpenPencilBridge;
  runId?: string;
  traceId?: string;
  groupId?: string;
  mode?: EditorAgentRunContext["mode"];
  model?: string;
  includeUnsafeTools?: boolean;
  maxTurns?: number;
  onEvent?: EditorAgentRunContext["onEvent"];
};

export type EditorAgentRuntime = {
  agent: Agent<EditorAgentRunContext, typeof editorAgentResultSchema>;
  context: EditorAgentRunContext;
};

export function createEditorAgent(
  input: EditorAgentInput,
  options: EditorAgentOptions,
): EditorAgentRuntime {
  const context: EditorAgentRunContext = {
    input,
    bridge: options.bridge,
    runId: options.runId ?? crypto.randomUUID(),
    mode: options.mode ?? "auto",
    graphRevision: input.openPencil.graphRevision,
    validationPassed: false,
    onEvent: options.onEvent,
  };

  const agent = new Agent<EditorAgentRunContext, typeof editorAgentResultSchema>({
    name: "Editor Agent",
    model: options.model ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
    instructions: EDITOR_AGENT_INSTRUCTIONS,
    modelSettings: {
      parallelToolCalls: false,
      reasoning: { summary: "concise" },
    },
    tools: createOpenPencilAgentTools({
      includeUnsafe: options.includeUnsafeTools === undefined ? true : options.includeUnsafeTools,
    }),
    outputType: editorAgentResultSchema,
  });

  return { agent, context };
}

export async function runEditorAgent(
  input: EditorAgentInput,
  options: EditorAgentOptions,
): Promise<{ output: EditorAgentResult; context: EditorAgentRunContext }> {
  const runtime = createEditorAgent(input, options);
  const traceId = options.traceId ?? generateTraceId();
  const groupId = options.groupId ?? `editor-task:${input.task.id}`;
  const traceMetadata = {
    agent: "editor",
    run_id: runtime.context.runId,
    task_id: input.task.id,
    idea_id: input.idea.id,
  };

  runtime.context.onEvent?.({
    type: "status",
    status: runtime.context.mode,
    message: "Editor agent started",
    runId: runtime.context.runId,
    traceId,
  });

  // The SDK's default tracing is enabled, but an explicit trace gives every
  // editor run a stable dashboard/search key and keeps related retries grouped.
  const result = await withTrace(
    "BMT Editor Agent",
    async () => {
      const stream = await run(runtime.agent, buildEditorAgentInput(input), {
        context: runtime.context,
        stream: true,
        // Multi-card composition needs generous room for inspection, per-card
        // rendering, image cloning/reparenting, export refinement, repair
        // loops, progress checkpoints, and one final structured-output turn.
        maxTurns: options.maxTurns ?? 200,
      });

      for await (const event of stream) {
        if (event.type === "raw_model_stream_event" && event.data.type === "output_text_delta") {
          runtime.context.onEvent?.({
            type: "assistant_delta",
            text: event.data.delta,
          });
        }

        // Reasoning item contents are deliberately not forwarded to the
        // browser. The UI receives a safe activity marker and the agent's
        // explicit report_progress summaries instead of private chain-of-
        // thought text.
        if (event.type === "run_item_stream_event" && event.name === "reasoning_item_created") {
          runtime.context.onEvent?.({
            type: "reasoning_update",
            message: "에이전트가 다음 편집 단계를 판단하고 있어요.",
          });
        }
      }

      await stream.completed;
      return stream;
    },
    { traceId, groupId, metadata: traceMetadata },
  );

  if (!result.finalOutput) {
    throw new Error("Editor agent completed without structured output");
  }

  const unresolved = [...result.finalOutput.unresolved];
  if (result.finalOutput.status === "completed" && !runtime.context.validationPassed) {
    unresolved.push("Final carousel validation did not pass after the last document mutation.");
  }
  const skippedVisualVerification = result.finalOutput.warnings.some((warning) =>
    /export_image|export.*(보류|실패|확인하지 못|unavailable)|visual.*(not|skip|fail)/i.test(warning),
  );
  if (result.finalOutput.status === "completed" && skippedVisualVerification) {
    unresolved.push("Per-card export_image visual verification was skipped or failed; structural validation alone is insufficient.");
  }
  const finalOutput: EditorAgentResult = result.finalOutput.status === "completed" && unresolved.length > 0
    ? { ...result.finalOutput, status: "needs_input", unresolved }
    : result.finalOutput;

  runtime.context.onEvent?.({
    type: "status",
    status: finalOutput.status,
    message: finalOutput.status === "completed"
      ? "Editor agent completed"
      : finalOutput.status === "needs_input"
        ? "Editor agent needs additional input or tooling"
        : "Editor agent failed",
    output: finalOutput,
    runId: runtime.context.runId,
    traceId,
  });

  return { output: finalOutput, context: runtime.context };
}
