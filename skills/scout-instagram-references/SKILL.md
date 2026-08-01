---
name: scout-instagram-references
description: Discover public Instagram single-image and carousel posts related to a user's planned topic with Apify, verify direct post URLs and public metrics, rank topic-matched references without treating missing metrics as zero, extract evidence-backed creative patterns, and prepare editor-agent context. Use when a marketer needs competitive references, current feed-post formats, reusable hooks, carousel structures, or topic-specific inspiration before creating an Instagram post.
---

# Scout Instagram References

Use Apify as the primary discovery provider. Treat scraped results as public,
unofficial evidence that may become unavailable when Instagram changes.

Read [output-schema.md](references/output-schema.md) before returning results.

## Inputs

- `topic`: Required description of the planned post.
- `objective`: Desired viewer action. Default to an empty string.
- `timeRange`: `7d`, `30d`, `90d`, or `any`. Default to `30d`.
- `region`: Search market such as `KR` or `global`. Default to `KR`.
- `formatFocus`: `carousel`, `single_image`, or `all` for the current MVP.
- `maxReferences`: Integer from 1 to 3. Default to 3.

Return no references for `reel`; the current workflow excludes video posts.

## Workflow

1. Validate that `topic` is concrete enough to search. Do not invent a topic.
2. Derive exactly three compact hashtag keyword variants and construct their
   Instagram hashtag URLs locally.
3. Run Apify Instagram Scraper once with `resultsType: posts` and collect at
   most 18 posts total across those hashtag URLs.
4. Keep direct canonical `instagram.com/p/` URLs only. Exclude `/reel/`,
   `/tv/`, video media types, and `productType: clips`.
5. Deduplicate and filter by the requested feed format.
6. Filter by topic before ranking. Select and analyze at most three references.
   Do not select a
   post merely because its engagement is high.
7. Analyze captions and supplied preview images only. Record evidence scope as
   `full_post`, `public_preview`, `text_only`, or `unavailable`.
8. Analyze reusable design evidence as well as hooks: layout, visual hierarchy,
   typography, color, image treatment, spacing, information density, and
   carousel flow when visible.
9. Rank references with the deterministic scoring rules below. Keep at most two
   references from one creator.
10. Extract reusable hooks, information hierarchy, carousel flow, image/text
    balance, and CTA principles. Never copy distinctive text, artwork,
    branding, or a complete slide sequence.
10. Do not retry collection or perform a fallback search when fewer than three
    valid references remain. An empty result is valid.
11. Return the structure in
    [output-schema.md](references/output-schema.md).

## Public metrics

- Preserve public likes, comments, and timestamp exactly.
- Convert hidden values such as `-1` to `null`.
- Keep unavailable saves and shares as `null`; never infer them.
- Do not substitute missing metrics with zero.
- Calculate weighted public reactions only when both likes and comments are
  present:

```text
weightedPublicReactions = likes + 3 × comments
```

## Ranking

Use these weights:

```text
topic similarity               45%
public likes and comments        30%
recency                         15%
evidence coverage               10%
```

Normalize performance within the candidate set. If a component is unknown,
exclude its weight and renormalize the remaining weights; do not score the
unknown component as zero. Do not use account outlier ratios in the MVP.

Rank posts, not accounts. Use creator diversity only as a final cap.

## Evidence rules

- Preserve each direct Instagram URL and every supporting hashtag/source URL.
- Treat Apify as the collection provider, not an official Instagram API.
- Separate observation, interpretation, and hypothesis.
- Keep confidence and collection limitations.
- Set `performanceSignal` to `unknown` when either likes or comments is
  unavailable.
- If no verified post remains, return an empty `references` array and explain
  the failed collection stage.
- Write synthesized findings in Korean while preserving URLs and handles.

## Handoff

Pass `references`, `patterns`, and `editorContext` to the marketer/editor
workflow. Adapt only `transferableElements` to the user's brand.
