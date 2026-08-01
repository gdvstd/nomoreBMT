import { Agent, run } from "@openai/agents";

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
1. Inspect the current document and target nodes with get_selection, get_node,
   get_jsx, or describe before changing anything.
2. Plan the card hierarchy from the selected idea card. Reuse the supplied
   asset manifest and existing asset node IDs whenever possible.
3. Compose the cards using OpenPencil tools: create or update frames, place and
   crop assets, set fills/strokes/layout, and set text. Keep each card as a
   separately addressable root node.
4. Call export_image after meaningful composition changes. Treat the returned
   image as a visual verification checkpoint and refine spacing, hierarchy,
   contrast, cropping, and legibility when needed.
5. Finish only after the result is actually present in the document. Return
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
  return [
    "Create the requested composition in the connected OpenPencil document.",
    "\nTASK\n",
    safeJson(input.task),
    "\nSELECTED IDEA CARD\n",
    safeJson(input.ideaCard),
    "\nASSET MANIFEST\n",
    safeJson(input.assets),
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
  mode?: EditorAgentRunContext["mode"];
  model?: string;
  includeUnsafeTools?: boolean;
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
    model: options.model ?? process.env.OPENAI_MODEL ?? "gpt-5.6",
    instructions: EDITOR_AGENT_INSTRUCTIONS,
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
  runtime.context.onEvent?.({
    type: "status",
    status: runtime.context.mode,
    message: "Editor agent started",
  });

  const result = await run(runtime.agent, buildEditorAgentPrompt(input), {
    context: runtime.context,
  });

  if (!result.finalOutput) {
    throw new Error("Editor agent completed without structured output");
  }

  runtime.context.onEvent?.({
    type: "status",
    status: "completed",
    message: "Editor agent completed",
    output: result.finalOutput,
  });

  return { output: result.finalOutput, context: runtime.context };
}
