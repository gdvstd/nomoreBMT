import { z } from "zod";

import { slidePlanSchema } from "@/lib/editor-input/types";

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
  /** Reusable onboarding profile shared with downstream agents. */
  brandContext: z.unknown().optional(),
  language: z.string().default("ko"),
  target: z.string().default("instagram_carousel"),
  assets: z.object({
    assetSetId: z.string(),
    items: z.array(marketerAssetSchema).min(1).max(9),
  }),
});

/**
 * A design reference the marketer drew on. The server builds this from the
 * verified input references (never the model) so URLs and identities stay
 * trustworthy. Slides cite it by `id`; the UI renders it as provenance.
 */
export const marketerReferenceSchema = z.object({
  id: z.string(),
  instagramUrl: z.string().url(),
  creatorHandle: z.string().nullable(),
  previewImageUrl: z.string().url().nullable(),
  borrowedPatterns: z.array(z.string()).max(6).default([]),
});

/**
 * One selectable idea card. It now carries a fully-authored slide plan so no
 * separate EditorInput Planner inference is needed after selection.
 */
export const marketerIdeaCardSchema = z.object({
  id: z.string(),
  label: z.string(),
  title: z.string(),
  hook: z.string(),
  description: z.string(),
  format: z.string(),
  accent: z.enum(["coral", "blue"]),
  /** Human-readable asset labels (server-normalized). */
  assets: z.array(z.string()).default([]),
  /** Exact user photo IDs this card draws on. */
  assetIds: z.array(z.string()).default([]),
  /** Which references (by MarketerReference.id) inform this card. */
  referenceIds: z.array(z.string()).max(2).default([]),
  /** Card-level shared art direction (replaces EditorInput.design.description). */
  designDirection: z.string().min(1),
  slides: z.array(slidePlanSchema).min(2).max(10),
});

/** What the model is asked to return (references are attached server-side). */
export const marketerModelOutputSchema = z.object({
  researchBrief: z.object({
    topic: z.string(),
    purpose: z.string(),
    searchTerms: z.array(z.string()).default([]),
  }),
  ideas: z.array(marketerIdeaCardSchema).length(2),
});

/** One server-computed check that the marketer followed its assigned procedure. */
export const marketerComplianceCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});

/**
 * The final marketer output surfaced to the app: model output + trustworthy
 * references + a procedure-compliance report.
 */
export const marketerAgentOutputSchema = marketerModelOutputSchema.extend({
  references: z.array(marketerReferenceSchema).default([]),
  compliance: z.array(marketerComplianceCheckSchema).default([]),
});

export type MarketerAgentInput = z.infer<typeof marketerAgentInputSchema>;
export type MarketerReference = z.infer<typeof marketerReferenceSchema>;
export type MarketerIdeaCard = z.infer<typeof marketerIdeaCardSchema>;
export type MarketerModelOutput = z.infer<typeof marketerModelOutputSchema>;
export type MarketerComplianceCheck = z.infer<typeof marketerComplianceCheckSchema>;
export type MarketerAgentOutput = z.infer<typeof marketerAgentOutputSchema>;

export type MarketerAgentEvent =
  | { type: "status"; status: "started" | "streaming" | "completed" | "failed"; message: string; runId?: string; traceId?: string }
  | { type: "reasoning_update"; message: string }
  | { type: "assistant_delta"; text: string }
  | { type: "tool_started"; toolName: string; args?: Record<string, unknown> }
  | { type: "tool_finished"; toolName: string; resultSummary?: string }
  | { type: "result"; output: MarketerAgentOutput };
