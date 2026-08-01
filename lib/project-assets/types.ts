import { z } from "zod";

export const projectAssetSourceSchema = z.enum([
  "user_upload",
  "instagram_reference",
]);

export const projectAssetSchema = z.object({
  assetId: z.string().min(1),
  projectId: z.string().uuid(),
  sourceType: projectAssetSourceSchema,
  storagePath: z.string().min(1),
  signedUrl: z.string().url(),
  name: z.string().optional(),
  description: z.string().max(2_000).optional(),
  mimeType: z.string().min(1),
  sourceUrl: z.string().url().optional(),
  sourcePostUrl: z.string().url().optional(),
  sourceSlideIndex: z.number().int().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

export type ProjectAsset = z.infer<typeof projectAssetSchema>;
