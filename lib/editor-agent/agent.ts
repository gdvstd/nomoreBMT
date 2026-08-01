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
   Keep render JSX deliberately simple and balanced. Never use JSX expressions
   such as {"\\n"}; use separate Text nodes when a visual line break is needed.
   If render reports a parse error, retry with one root Frame and simple direct
   children, then add detail in smaller render calls. A JSX parse error is not
   a reason to return needs_input because valid minimal JSX remains available.
5. Plan the card hierarchy from the selected idea card. Reuse the supplied
   asset manifest and existing asset node IDs whenever possible.
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
6. Compose the cards using OpenPencil tools: create or update frames, place and
   crop assets, set fills/strokes/layout, and set text. Keep each card as a
   separately addressable root node.
7. After each meaningful step, call report_progress with phase
   "step_completed" and the actual percent, then continue to the next step.
8. Call export_image with one card root ID at a time after meaningful
   composition changes so every 1080x1350 card can be inspected at full size.
   Treat each image as a visual verification checkpoint and refine spacing,
   hierarchy, contrast, cropping, and legibility when needed. An {error: ...}
   result is a failed checkpoint, not an image.
9. After the final mutation and per-card visual checks, call
   validate_carousel. Repair every returned error and call it again. Do not
   mutate the document after it returns ok=true unless you validate again.
10. Finish only after validate_carousel returns ok=true and every requested
   card is populated. Return status completed only when unresolved is empty.
   Call report_progress with phase "workflow_completed" at 100, then return
   concise structured metadata including cardRoots, one slides entry per card
   with its actual title/copy/asset IDs, the final post caption, summary,
   warnings, and unresolved items.

Design constraints:
- Treat the supplied EditorInput as the authoritative slide count, visible
  text, shared design direction, per-slide composition, and user-image mapping.
- Design-reference images are visual evidence only. Never place them in the
  finished composition; only user-photo URLs may become slide imagery.
- Follow the provided design principles and idea card before adding stylistic
  choices. Preserve the user's brand voice and requested language.
- Prefer the user's assets over stock or newly invented substitutes.
- Do not use arbitrary code execution. Do not delete unrelated user content.
- Never claim that a card is complete when a tool failed or a visual checkpoint
  was not completed. If the bridge or an asset is unavailable, report
  needs_input or failed with a concrete unresolved item.
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
  return [
    "Create the requested composition in the connected OpenPencil document.",
    "\nTASK\n",
    safeJson(input.task),
    "\nAUTHORITATIVE EDITOR INPUT\n",
    safeJson(input.editorInput),
    "\nSELECTED IDEA CARD\n",
    safeJson(input.ideaCard),
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

  for (const url of input.editorInput.design.referenceImageUrls) {
    if (seen.has(url)) continue;
    seen.add(url);
    content.push({
      type: "input_text",
      text: "DESIGN_REFERENCE: analyze visual principles only; never render this image.",
    });
    content.push({ type: "input_image", image: url, detail: "high" });
  }
  for (const [index, slide] of input.editorInput.slides.entries()) {
    if (!slide.imageUrl || seen.has(slide.imageUrl)) continue;
    seen.add(slide.imageUrl);
    content.push({
      type: "input_text",
      text: `USER_PHOTO for slide ${index + 1}: this image may be placed in the result.`,
    });
    content.push({
      type: "input_image",
      image: slide.imageUrl,
      detail: "high",
    });
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
    idea_id: input.ideaCard.id,
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
        // Six-card composition needs room for inspection, per-card rendering,
        // image cloning/reparenting, export refinement, progress checkpoints,
        // and one final structured-output turn.
        maxTurns: options.maxTurns ?? 80,
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
