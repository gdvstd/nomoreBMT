---
name: scout-instagram-references
description: Find public Instagram post references related to a user's planned topic through web search, verify direct Instagram post or Reel URLs, compare topic and format similarity, extract evidence-backed creative patterns, and prepare reference context for an editor agent. Use when a marketer agent needs stronger examples, competitive inspiration, current Instagram formats, reusable hooks, carousel structures, or topic-specific reference posts before creating content.
---

# Scout Instagram References

Use web search to discover public Instagram references. A search result is a
candidate, not proof that the post is popular or visually strong.

## Inputs

- `topic`: Required description of what the user plans to publish.
- `objective`: Desired viewer action or business goal. Default to an empty
  string.
- `timeRange`: One of `7d`, `30d`, `90d`, or `any`. Default to `30d`.
- `region`: Search market such as `KR` or `global`. Default to `KR`.
- `formatFocus`: One of `carousel`, `reel`, `single_image`, or `all`. Default to
  `carousel`.
- `maxReferences`: Integer from 1 to 8. Default to 5.

## Workflow

1. Validate that `topic` is concrete enough to search. Do not invent a topic.
2. Build four to six queries using Korean and English variants where useful.
   Include queries targeting `site:instagram.com/p/` and
   `site:instagram.com/reel/`, the requested format, region, recency, and
   engagement-oriented terms.
3. Run web search. Search must execute at least once.
4. Accept a reference only when a direct canonical URL under
   `instagram.com/p/`, `instagram.com/reel/`, or `instagram.com/tv/` is
   discoverable. Keep articles and roundups only as supporting sources.
5. Deduplicate reposts, tracking URLs, and repeated URLs.
6. Score topic, audience, and format similarity separately. Explain each score
   from observable evidence.
7. Record popularity numbers only when a source explicitly exposes them. Do not
   infer likes, comments, saves, shares, views, or follower count.
8. Analyze the hook, content structure, visual pattern, and engagement
   mechanism only to the level visible in the public result. Mark the visual
   evidence scope as `full_post`, `public_preview`, `text_only`, or
   `unavailable`.
9. Extract transferable principles. Do not suggest copying distinctive text,
   artwork, branding, or an entire slide sequence.
10. Return the structure in [output-schema.md](references/output-schema.md).

## Ranking

Prioritize in this order:

1. Topic and intent similarity.
2. Direct Instagram URL verification.
3. Explicit, traceable engagement evidence.
4. Format similarity.
5. Recency.

Never rank raw engagement counts across differently sized accounts as if they
were directly comparable. Use `unknown` when popularity cannot be verified.

## Evidence and confidence

- Preserve every source URL used for a claim.
- Clearly distinguish the Instagram post URL from supporting sources.
- Keep low-confidence references when useful, but label the limitation.
- If no verified Instagram URL is found, return an empty reference list instead
  of replacing it with blog posts.
- Write synthesized findings in Korean while preserving URLs and handles.

## Handoff

Pass `references`, `patterns`, and `editorContext` to the editor agent. The
editor should adapt the underlying mechanism to the user's identity, not imitate
the source asset.
