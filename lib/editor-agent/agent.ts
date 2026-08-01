import { Agent, generateTraceId, run, withTrace } from "@openai/agents";

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
4. Plan the card hierarchy from the selected idea card. Reuse the supplied
   asset manifest and existing asset node IDs whenever possible.
   The browser preloads the user's actual images into the mapped node IDs with
   OpenPencil's set_image_fill tool. Preserve those nodes and their image fills:
   never use a supplied image node ID as render.replace_id. Reparent, resize,
   and position the existing image nodes inside the card roots. Only call
   set_image_fill when image_data is actually available. Never finish with only
   seeded placeholder rectangles.
5. Compose the cards using OpenPencil tools: create or update frames, place and
   crop assets, set fills/strokes/layout, and set text. Keep each card as a
   separately addressable root node.
6. After each meaningful step, call report_progress with phase
   "step_completed" and the actual percent, then continue to the next step.
7. Call export_image after meaningful composition changes. Treat the returned
   image as a visual verification checkpoint and refine spacing, hierarchy,
   contrast, cropping, and legibility when needed.
8. Finish only after the result is actually present in the document. Call
   report_progress with phase "workflow_completed" at 100, then return
   concise structured metadata: card root IDs, summary, warnings, and anything
   unresolved.

Design constraints:
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
    "\nSELECTED IDEA CARD\n",
    safeJson(input.ideaCard),
    "\nASSET MANIFEST\n",
    safeJson(promptAssets),
    "\nOPENPENCIL CONTEXT\n",
    safeJson(input.openPencil),
    "\nDESIGN PRINCIPLES\n",
    safeJson(input.designPrinciples),
    input.marketerContext
      ? `\nMARKETER CONTEXT\n${safeJson(input.marketerContext)}`
      : "",
  ].join("\n");
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
      const stream = await run(runtime.agent, buildEditorAgentPrompt(input), {
        context: runtime.context,
        stream: true,
        // A multi-card composition routinely needs more than the SDK default
        // 10 model/tool turns (inspection, per-card render, asset placement,
        // export verification, and progress checkpoints).
        maxTurns: options.maxTurns ?? 40,
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

  runtime.context.onEvent?.({
    type: "status",
    status: result.finalOutput.status,
    message: result.finalOutput.status === "completed"
      ? "Editor agent completed"
      : result.finalOutput.status === "needs_input"
        ? "Editor agent needs additional input or tooling"
        : "Editor agent failed",
    output: result.finalOutput,
    runId: runtime.context.runId,
    traceId,
  });

  return { output: result.finalOutput, context: runtime.context };
}
