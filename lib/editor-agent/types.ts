import { z } from "zod";
import {
  marketerIdeaCardSchema,
  marketerReferenceSchema,
} from "@/lib/marketer-agent/types";

/**
 * The editor agent works on logical asset references rather than filesystem
 * paths. The browser/worker can resolve these references to signed URLs or
 * already-imported OpenPencil nodes.
 */
export const editorAssetSchema = z.object({
  assetId: z.string(),
  kind: z.enum(["image", "video", "generated", "logo", "font", "other"]),
  name: z.string().optional(),
  url: z.string().url().optional(),
  nodeId: z.string().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const editorTaskSchema = z.object({
  id: z.string(),
  request: z.string().min(1),
  target: z.string().default("instagram_carousel"),
  language: z.string().default("ko"),
  cardCount: z.number().int().positive().max(20).optional(),
});

export const editorDesignPrinciplesSchema = z.object({
  version: z.string().optional(),
  rules: z.array(z.string()).default([]),
  brandColors: z.array(z.string()).optional(),
  typography: z.record(z.string(), z.unknown()).optional(),
  forbiddenPatterns: z.array(z.string()).default([]),
});

export const openPencilContextSchema = z.object({
  sessionId: z.string(),
  documentId: z.string().optional(),
  pageId: z.string().optional(),
  graphRevision: z.string().optional(),
  targetNodeIds: z.array(z.string()).default([]),
  cardRootIds: z.array(z.string()).default([]),
  assetNodeIds: z.array(z.string()).default([]),
  canvasWidth: z.number().positive().optional(),
  canvasHeight: z.number().positive().optional(),
});

export const editorAgentInputSchema = z.object({
  /** The selected idea card carries the authoritative slide plan. */
  idea: marketerIdeaCardSchema,
  /** Design references the marketer drew on (evidence only, never rendered). */
  references: z.array(marketerReferenceSchema).default([]),
  task: editorTaskSchema,
  assets: z.object({
    assetSetId: z.string(),
    items: z.array(editorAssetSchema),
  }),
  openPencil: openPencilContextSchema,
  designPrinciples: editorDesignPrinciplesSchema,
  /** Stable brand profile generated from the user's onboarding answers. */
  brandContext: z.unknown().optional(),
  marketerContext: z.unknown().optional(),
}).superRefine((value, context) => {
  if (
    value.task.cardCount !== undefined &&
    value.task.cardCount !== value.idea.slides.length
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["task", "cardCount"],
      message: `cardCount must match the slide plan (${value.idea.slides.length}).`,
    });
  }
  const knownAssetIds = new Set(value.assets.items.map((asset) => asset.assetId));
  value.idea.slides.forEach((slide, index) => {
    if (!slide.sourceAssetId || !knownAssetIds.has(slide.sourceAssetId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["idea", "slides", index, "sourceAssetId"],
        message: "Every slide must reference a supplied user asset.",
      });
    }
  });
  if (value.openPencil.assetNodeIds.length !== value.assets.items.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["openPencil", "assetNodeIds"],
      message: "Every user asset must have one ordered source node.",
    });
  }
});

export const editorAgentResultSchema = z.object({
  status: z.enum(["completed", "needs_input", "failed"]),
  documentId: z.string().optional(),
  pageId: z.string().optional(),
  cardRoots: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      nodeId: z.string(),
      purpose: z.string(),
      assetIds: z.array(z.string()).default([]),
    }),
  ).default([]),
  slides: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      nodeId: z.string(),
      title: z.string(),
      copy: z.string(),
      assetIds: z.array(z.string()).default([]),
    }),
  ).default([]),
  caption: z.string().default(""),
  summary: z.string(),
  warnings: z.array(z.string()).default([]),
  unresolved: z.array(z.string()).default([]),
});

export type EditorAsset = z.infer<typeof editorAssetSchema>;
export type EditorAgentInput = z.infer<typeof editorAgentInputSchema>;
export type EditorAgentResult = z.infer<typeof editorAgentResultSchema>;

export type EditorAgentMode = "auto" | "live" | "review";

export type OpenPencilToolRequest = {
  runId: string;
  toolName: string;
  args: Record<string, unknown>;
  expectedRevision?: string;
};

export type OpenPencilToolResult = {
  result: unknown;
  graphRevision?: string;
};

/**
 * A transport boundary between the server-side agent and the authoritative
 * OpenPencil graph in the browser. A WebSocket/SSE implementation can be
 * supplied later without changing the agent or its tool names.
 */
export interface OpenPencilBridge {
  invoke(request: OpenPencilToolRequest): Promise<OpenPencilToolResult>;
}

export type EditorAgentEvent =
  | {
      type: "plan";
      steps: Array<{
        id: string;
        label: string;
        detail?: string;
      }>;
    }
  | {
      type: "progress";
      stepId: string;
      stepIndex: number;
      totalSteps: number;
      status: "started" | "completed" | "blocked";
      percent: number;
      message?: string;
    }
  | { type: "assistant_delta"; text: string }
  | { type: "reasoning_update"; message: string }
  | { type: "tool_started"; toolName: string; args: Record<string, unknown> }
  | { type: "tool_finished"; toolName: string; result: unknown; graphRevision?: string }
  | { type: "tool_failed"; toolName: string; error: string }
  | {
      type: "status";
      status: EditorAgentMode | "completed" | "needs_input" | "failed";
      message: string;
      output?: EditorAgentResult;
      runId?: string;
      traceId?: string;
    };

export type EditorAgentRunContext = {
  input: EditorAgentInput;
  bridge: OpenPencilBridge;
  runId: string;
  mode: EditorAgentMode;
  graphRevision?: string;
  validationPassed?: boolean;
  onEvent?: (event: EditorAgentEvent) => void;
};
