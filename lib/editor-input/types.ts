import { z } from "zod";

/**
 * Shared "content plan" contract authored by the Marketing Agent and consumed
 * by both the UI provenance panel and the Editor Agent.
 *
 * Three layers live here:
 *  - HARD CONTRACT (machine-validated by validateCarousel + the editor):
 *    sourceAssetId, imageTreatment, and the text element set.
 *  - PROVENANCE / GROUNDING (shown in the UI, read by the editor, never
 *    machine-validated): intent, imageIntent, referenceInspirations.
 *  - SOFT execution (exact geometry, type size, color, overlays) is decided by
 *    the Editor Agent at runtime and verified on the rendered graph, so it is
 *    intentionally absent from this contract.
 */

/** A single visible text element. The editor authors the exact size/color. */
export const slideTextItemSchema = z.object({
  role: z.enum(["hook", "title", "body", "caption", "cta", "label"]),
  content: z.string().min(1),
});

/** How one design reference informed this slide (UI display + editor grounding). */
export const referenceInspirationSchema = z.object({
  /** Points at MarketerReference.id supplied to the marketer. */
  referenceId: z.string(),
  /** The reusable principle taken from the reference. */
  borrowed: z.string().min(1),
  /** How it was adapted to the user's brand/photo, not copied. */
  adaptedHow: z.string().min(1),
});

export const slidePlanSchema = z.object({
  // ── Hard contract ────────────────────────────────────────────────
  /** Stable id of the user photo used on this slide. */
  sourceAssetId: z.string(),
  /** Replaces the old prose full-bleed regex with an explicit contract. */
  imageTreatment: z.enum(["full_bleed", "contained"]),
  /** null = an intentionally text-free slide. */
  text: z.array(slideTextItemSchema).nullable(),

  // ── Provenance / grounding ───────────────────────────────────────
  /** Communication goal + relation to the previous/next slide. */
  intent: z.string().min(1),
  /** Crop anchor, focal subject, and which region to keep in frame. */
  imageIntent: z.string().min(1),
  /** Up to two references that informed this slide. */
  referenceInspirations: z.array(referenceInspirationSchema).max(2).default([]),
});

export type SlideTextItem = z.infer<typeof slideTextItemSchema>;
export type ReferenceInspiration = z.infer<typeof referenceInspirationSchema>;
export type SlidePlan = z.infer<typeof slidePlanSchema>;
