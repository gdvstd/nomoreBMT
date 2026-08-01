import { z } from "zod";

export const marketerAssetSchema = z.object({
  assetId: z.string(),
  kind: z.enum(["image", "video", "generated", "logo", "other"]).default("image"),
  name: z.string().optional(),
  /** User-provided context for the specific image; passed to the model with the asset manifest. */
  description: z.string().max(2_000).optional(),
  /** Signed URL or a data URL for the one-shot multimodal inference. */
  url: z.string().optional(),
  /** OpenAI Files API ID, when the asset was uploaded server-side. */
  fileId: z.string().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});

export const marketerAgentInputSchema = z.object({
  taskId: z.string(),
  request: z.string().min(1),
  brandDirection: z.string().default(""),
  language: z.string().default("ko"),
  target: z.string().default("instagram_carousel"),
  assets: z.object({
    assetSetId: z.string(),
    items: z.array(marketerAssetSchema).min(1),
  }),
});

export const marketerIdeaCardSchema = z.object({
  id: z.string(),
  label: z.string(),
  title: z.string(),
  hook: z.string(),
  description: z.string(),
  format: z.string(),
  assets: z.array(z.string()).min(1),
  assetIds: z.array(z.string()).default([]),
  slides: z.array(z.string()).min(3).max(12),
  accent: z.enum(["coral", "blue"]),
});

/** Exactly two selectable idea cards are returned from one model inference. */
export const marketerAgentOutputSchema = z.object({
  ideas: z.array(marketerIdeaCardSchema).length(2),
});

export type MarketerAgentInput = z.infer<typeof marketerAgentInputSchema>;
export type MarketerIdeaCard = z.infer<typeof marketerIdeaCardSchema>;
export type MarketerAgentOutput = z.infer<typeof marketerAgentOutputSchema>;

export type MarketerAgentEvent =
  | { type: "status"; status: "started" | "streaming" | "completed" | "failed"; message: string; runId?: string; traceId?: string }
  | { type: "assistant_delta"; text: string }
  | { type: "tool_started"; toolName: string }
  | { type: "tool_finished"; toolName: string }
  | { type: "result"; ideas: MarketerIdeaCard[] };
