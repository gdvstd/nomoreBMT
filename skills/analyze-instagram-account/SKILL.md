---
name: analyze-instagram-account
description: Analyze an owned Instagram professional account using its API media, carousel slides, comments, and insights, then produce evidence-linked marketing context for an editor agent. Use when a marketer agent needs to audit existing posts, identify winning and weak patterns, inspect visual readability and carousel flow, understand audience reactions, or prepare guidance for the next post.
---

# Analyze Instagram Account

Analyze only the connected user's owned-account evidence. Do not use public web
search as a substitute for missing account metrics.

## Workflow

1. Retrieve the profile, recent media, ordered carousel children, comments, and
   available per-media insights through the configured Instagram API.
2. Preserve post, slide, and comment IDs so every important finding can point to
   evidence.
3. Calculate reach-normalized rates and account baselines deterministically
   before asking a language model to interpret them. Never ask the model to
   recalculate authoritative metrics.
4. Inspect every available image. Evaluate text readability, contrast,
   hierarchy, spacing, clipping, alignment, visual consistency, and information
   density.
5. Evaluate each carousel as a sequence: cover promise, middle-slide
   progression, topic continuity, repeated content, and final CTA.
6. Separate observed facts from interpretations. Lower confidence when reach,
   comments, images, or comparable posts are sparse.
7. Return the structure in [output-schema.md](references/output-schema.md).

## Evidence rules

- Link performance claims to post IDs and visual claims to both post and slide
  IDs.
- Treat missing metrics as unavailable, never as zero.
- Do not claim a visual caused performance. Phrase correlations as hypotheses.
- Do not call a pattern winning or weak from one low-reach post without a
  prominent limitation.
- Quote comments minimally and preserve their IDs.
- Do not infer private demographic attributes from commenters or images.
- Write final findings in Korean while preserving IDs, URLs, and metric names.

## Failure behavior

- If authentication or API access fails, report the provider error and stop.
- If no media is returned, produce no invented analysis.
- If comments or insights are unavailable, continue with partial evidence and
  list the missing coverage.
- If an image cannot be loaded, omit its visual findings and record a warning.

## Handoff

Pass `editorContext` plus its evidence IDs to the editor agent. Keep raw access
tokens and full provider responses out of the handoff.
