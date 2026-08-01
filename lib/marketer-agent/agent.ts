import { Agent, generateTraceId, run, user, withTrace, type AgentInputItem } from "@openai/agents";

import {
  marketerAgentOutputSchema,
  type MarketerAgentInput,
  type MarketerAgentEvent,
  type MarketerAgentOutput,
} from "./types";

export const MARKETER_AGENT_INSTRUCTIONS = `
You are the Marketing Agent for a personal-brand content platform.

Create exactly two distinct, selectable Instagram carousel idea cards from the
user's brief, brand direction, and supplied photos. This is a single inference:
do not ask follow-up questions, call external services, search Instagram, or
invent a third option.

Use the supplied images as the primary evidence. Identify useful subjects,
locations, moods, colors, and visual sequences from them. Each idea must be a
different editorial angle, not merely a reworded title. One can be practical,
saveable, or information-led; the other can be emotional, narrative, or
personality-led when that fits the material.

Return exactly two cards. Every card must include:
- a short label and title;
- a clear hook that explains why someone would stop or save it;
- a concise description of the narrative and visual treatment;
- the carousel format and a 3–12 slide plan;
- human-readable asset labels plus the exact asset IDs used.

Do not claim facts that are not present in the brief or visible in the assets.
Keep copy in the requested language and preserve the user's brand direction.
The result will be shown as two choice cards, so make the contrast obvious.
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
    "Generate exactly two idea cards for this content request.",
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
    "\nUse the assetId values exactly when assigning assets to each idea.\n",
  ].join("\n");
}

/**
 * Build one multimodal user message. Assets without a URL/file ID remain in
 * the manifest, while resolvable assets are also presented to the model as
 * image inputs in the same inference.
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

export function createMarketerAgent(options?: { model?: string }) {
  return new Agent({
    name: "Marketing Agent",
    model: options?.model ?? process.env.OPENAI_REFERENCE_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
    instructions: MARKETER_AGENT_INSTRUCTIONS,
    outputType: marketerAgentOutputSchema,
  });
}

export type MarketerAgentOptions = {
  model?: string;
  runId?: string;
  traceId?: string;
  groupId?: string;
  onEvent?: (event: MarketerAgentEvent) => void;
};

/** One streamed run() call, with no Instagram tools or follow-up inference. */
export async function runMarketerAgent(
  input: MarketerAgentInput,
  options: MarketerAgentOptions = {},
): Promise<MarketerAgentOutput> {
  const agent = createMarketerAgent(options);
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
    message: "Marketing agent started",
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
        message: "사진과 요청을 분석하고 두 가지 방향을 구성하고 있어요.",
        runId,
        traceId,
      });

      for await (const event of stream) {
        if (event.type === "raw_model_stream_event" && event.data.type === "output_text_delta") {
          options.onEvent?.({ type: "assistant_delta", text: event.data.delta });
        }
        if (event.type === "run_item_stream_event" && event.name === "tool_called") {
          const item = event.item.rawItem;
          if (item && item.type === "function_call") {
            options.onEvent?.({ type: "tool_started", toolName: item.name });
          }
        }
        if (event.type === "run_item_stream_event" && event.name === "tool_output") {
          const item = event.item.rawItem;
          if (item && item.type === "function_call_result") {
            options.onEvent?.({ type: "tool_finished", toolName: item.name });
          }
        }
      }

      await stream.completed;
      return stream;
    },
    { traceId, groupId, metadata: traceMetadata },
  );
  if (!result.finalOutput) throw new Error("Marketing agent completed without structured output");
  options.onEvent?.({ type: "result", ideas: result.finalOutput.ideas });
  options.onEvent?.({
    type: "status",
    status: "completed",
    message: "Marketing agent completed",
    runId,
    traceId,
  });
  return result.finalOutput;
}
