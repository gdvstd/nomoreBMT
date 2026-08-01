import { tool, type RunContext, type ToolOutputImage } from "@openai/agents";
import {
  ALL_TOOLS,
  CORE_TOOLS,
  type ParamDef,
  type ToolDef,
} from "@open-pencil/core/tools";
import { z } from "zod";

import type {
  EditorAgentRunContext,
  OpenPencilBridge,
  OpenPencilToolResult,
} from "./types";

const EXPORT_IMAGE_TOOL_NAME = "export_image";
const SET_IMAGE_FILL_TOOL_NAME = "set_image_fill";

const progressArgsSchema = z.object({
  phase: z.enum(["plan", "step_started", "step_completed", "blocked", "workflow_completed"]),
  stepId: z.string().min(1),
  stepIndex: z.number().int().nonnegative(),
  totalSteps: z.number().int().positive(),
  percent: z.number().int().min(0).max(100),
  message: z.string().min(1),
  steps: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    detail: z.string().optional(),
  })).optional(),
}).strict();

type ProgressArgs = z.infer<typeof progressArgsSchema>;

/**
 * This is an orchestration tool rather than an OpenPencil document tool. It
 * lets the agent publish an explicit plan and truthful checkpoints to the
 * product UI while keeping the canonical editor tools unchanged.
 */
export function createProgressReportTool() {
  return tool({
    name: "report_progress",
    description: "Report the editor plan and the current completed or blocked step. Call this before editing, after each meaningful step, and when the workflow completes.",
    parameters: progressArgsSchema,
    strict: true,
    execute: async (
      args: ProgressArgs,
      context?: RunContext<EditorAgentRunContext>,
    ) => {
      const runContext = getRunContext(context);
      runContext.onEvent?.({ type: "tool_started", toolName: "report_progress", args });

      if (args.phase === "plan" && args.steps?.length) {
        runContext.onEvent?.({
          type: "plan",
          steps: args.steps,
        });
      }

      const status = args.phase === "step_completed" || args.phase === "workflow_completed"
        ? "completed"
        : args.phase === "blocked"
          ? "blocked"
          : "started";

      runContext.onEvent?.({
        type: "progress",
        stepId: args.stepId,
        stepIndex: args.stepIndex,
        totalSteps: args.totalSteps,
        status,
        percent: args.percent,
        message: args.message,
      });

      const result = {
        ok: true,
        acknowledged: true,
        phase: args.phase,
        stepId: args.stepId,
        percent: args.percent,
      };
      runContext.onEvent?.({
        type: "tool_finished",
        toolName: "report_progress",
        result,
        graphRevision: runContext.graphRevision,
      });
      return result;
    },
  });
}

/**
 * Convert OpenPencil's canonical parameter description into a strict Zod
 * object. Defaults are intentionally not copied into the schema: OpenPencil's
 * own execute functions remain responsible for applying their defaults.
 */
export function openPencilParamsToZod(
  params: Record<string, ParamDef>,
): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [name, definition] of Object.entries(params)) {
    let value: z.ZodTypeAny;

    switch (definition.type) {
      case "number": {
        let numberValue = z.number();
        if (definition.min !== undefined) numberValue = numberValue.min(definition.min);
        if (definition.max !== undefined) numberValue = numberValue.max(definition.max);
        value = numberValue;
        break;
      }
      case "boolean":
        value = z.boolean();
        break;
      case "string[]":
        value = z.array(z.string());
        break;
      case "color":
      case "string":
      default:
        value = definition.enum?.length
          ? z.enum(definition.enum as [string, ...string[]])
          : z.string();
        break;
    }

    value = value.describe(definition.description);
    shape[name] = definition.required ? value : value.optional();
  }

  return z.object(shape).strict();
}

/**
 * OpenPencil owns the tool definitions. This function only selects the
 * canonical definitions to expose to the editor agent. Image fill and export
 * are extended OpenPencil tools required by the editor workflow.
 */
export function getOpenPencilToolDefs(options?: {
  includeUnsafe?: boolean;
}): ToolDef[] {
  const core = [...CORE_TOOLS];
  const exportImage = ALL_TOOLS.find((candidate) => candidate.name === EXPORT_IMAGE_TOOL_NAME);
  const setImageFill = ALL_TOOLS.find((candidate) => candidate.name === SET_IMAGE_FILL_TOOL_NAME);
  const defs = [...core];
  for (const definition of [setImageFill, exportImage]) {
    if (definition && !defs.some((candidate) => candidate.name === definition.name)) defs.push(definition);
  }

  // CORE_TOOLS remains the default surface, including OpenPencil's canonical
  // `eval` definition. Deployments that do not want arbitrary code execution
  // can opt out without changing any tool names or schemas.
  return options?.includeUnsafe === false
    ? defs.filter((candidate) => candidate.name !== "eval")
    : defs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Convert OpenPencil's export_image result to an Agents SDK image output. */
export function toAgentToolOutput(result: unknown): unknown {
  if (!isRecord(result)) return result;

  if (typeof result.base64 === "string" && typeof result.mimeType === "string") {
    const output: ToolOutputImage = {
      type: "image",
      image: { data: result.base64, mediaType: result.mimeType },
      detail: "high",
    };
    return output;
  }

  if (typeof result.url === "string") {
    const output: ToolOutputImage = {
      type: "image",
      image: { url: result.url },
      detail: "high",
    };
    return output;
  }

  return result;
}

function getRunContext(
  context: RunContext<EditorAgentRunContext> | undefined,
): EditorAgentRunContext {
  if (!context?.context) {
    throw new Error("Editor agent tool invoked without an EditorAgentRunContext");
  }
  return context.context;
}

/**
 * Adapt one canonical OpenPencil ToolDef to the OpenAI Agents SDK function
 * tool contract. Names, descriptions, and parameter semantics stay exactly
 * those defined by OpenPencil; only the transport is changed.
 */
export function openPencilToolToAgentTool(definition: ToolDef) {
  return tool({
    name: definition.name,
    description: definition.description,
    parameters: openPencilParamsToZod(definition.params),
    strict: true,
    execute: async (
      args: Record<string, unknown>,
      context?: RunContext<EditorAgentRunContext>,
    ) => {
      const runContext = getRunContext(context);

      if (runContext.mode === "review") {
        throw new Error("Editor tools are paused while the user is in review mode");
      }

      runContext.onEvent?.({ type: "tool_started", toolName: definition.name, args });

      try {
        const response: OpenPencilToolResult = await runContext.bridge.invoke({
          runId: runContext.runId,
          toolName: definition.name,
          args,
          expectedRevision: runContext.graphRevision,
        });

        runContext.graphRevision = response.graphRevision ?? runContext.graphRevision;
        const result = definition.name === EXPORT_IMAGE_TOOL_NAME
          ? toAgentToolOutput(response.result)
          : response.result;

        const eventResult = definition.name === EXPORT_IMAGE_TOOL_NAME && isRecord(response.result)
          ? {
              mimeType: response.result.mimeType,
              byteLength: response.result.byteLength,
              visualCheckpoint: true,
            }
          : result;

        runContext.onEvent?.({
          type: "tool_finished",
          toolName: definition.name,
          result: eventResult,
          graphRevision: runContext.graphRevision,
        });

        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        runContext.onEvent?.({ type: "tool_failed", toolName: definition.name, error: message });
        throw error;
      }
    },
  });
}

export function createOpenPencilAgentTools(options?: {
  toolDefs?: ToolDef[];
  includeUnsafe?: boolean;
}) {
  const definitions = options?.toolDefs ?? getOpenPencilToolDefs({
    includeUnsafe: options?.includeUnsafe,
  });
  return [createProgressReportTool(), ...definitions.map(openPencilToolToAgentTool)];
}

/** Execute canonical OpenPencil tools directly against a browser-owned FigmaAPI. */
export function createFigmaApiBridge(
  figma: Parameters<ToolDef["execute"]>[0],
  options?: { getGraphRevision?: () => string | undefined },
): OpenPencilBridge {
  const definitions = new Map(getOpenPencilToolDefs({ includeUnsafe: true }).map((definition) => [definition.name, definition]));

  return {
    async invoke(request) {
      const definition = definitions.get(request.toolName);
      if (!definition) throw new Error(`Unknown OpenPencil tool: ${request.toolName}`);

      const result = await definition.execute(figma, request.args);
      return {
        result,
        graphRevision: options?.getGraphRevision?.(),
      };
    },
  };
}
