import { z } from "zod";

import { marketerIdeaCardSchema } from "@/lib/marketer-agent/types";
import { projectAssetSchema } from "@/lib/project-assets/types";

export const editorTextItemSchema = z.object({
  content: z.string(),
  size: z.number().positive().max(300),
  color: z.string().min(1),
  font: z.string().min(1).optional(),
});

export const editorInputSchema = z.object({
  design: z.object({
    description: z.string().min(1),
    referenceImageUrls: z.array(z.string().url()).max(2),
  }),
  slides: z
    .array(
      z.object({
        text: z.array(editorTextItemSchema).nullable(),
        description: z.string().min(1),
        imageUrl: z.string().url().nullable(),
      }),
    )
    .min(1)
    .max(20),
});

export const generateEditorInputRequestSchema = z.object({
  taskId: z.string(),
  request: z.string().min(1),
  language: z.string().default("ko"),
  selectedIdea: marketerIdeaCardSchema,
  brandContext: z.unknown().optional(),
  userAssets: z.array(projectAssetSchema).min(1),
  referenceAssets: z.array(projectAssetSchema).max(2).default([]),
});

export type EditorInput = z.infer<typeof editorInputSchema>;
export type GenerateEditorInputRequest = z.infer<
  typeof generateEditorInputRequestSchema
>;
