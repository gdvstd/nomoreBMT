# Reference scouting output

Return one `InstagramReferenceContext` object with:

- `query`: Effective topic, objective, region, time range, and format.
- `searchSummary`: Provider, executed queries, verified count, confidence, and
  limitations.
- `references`: Ranked verified feed-post URLs with public evidence, scoring,
  creative analysis, and confidence.
- `patterns`: Recurring principles linked to supporting reference URLs.
- `editorContext`: Adaptable ideas, visual directions, hooks, and cautions.
- `sources`: Apify Actor documentation, hashtag URLs, direct posts, and any
  fallback web sources used.

Each reference has this shape:

```json
{
  "rank": 1,
  "instagramUrl": "https://www.instagram.com/p/...",
  "creatorHandle": "string or null",
  "previewImageUrls": ["server-attached public preview URL, up to 2"],
  "format": "carousel | single_image | unknown",
  "publishedAt": "ISO date or null",
  "topicSummary": "string",
  "observedMetrics": {
    "likes": "number or null",
    "comments": "number or null",
    "views": "number or null",
    "saves": null,
    "shares": null
  },
  "performanceSignal": "unknown | low | medium | high",
  "metricCaveat": "string",
  "rankingSignals": {
    "weightedPublicReactions": "number or null",
    "performanceScore": "0..1 or null",
    "recencyScore": "0..1 or null",
    "evidenceCoverage": 0.0,
    "referenceScore": 0.0
  },
  "match": {
    "topicSimilarity": 0.0,
    "audienceSimilarity": 0.0,
    "formatSimilarity": 0.0,
    "rationale": "string"
  },
  "creativeAnalysis": {
    "hook": "string",
    "contentStructure": ["string"],
    "visualPatterns": ["string"],
    "engagementMechanisms": ["string"],
    "transferableElements": ["string"],
    "avoidCopying": ["string"]
  },
  "visualEvidenceScope": "full_post | public_preview | text_only | unavailable",
  "sourceUrls": ["string"],
  "confidence": 0.0
}
```

`searchSummary.provider` is `apify` or `web_search`. Similarity, component
scores, evidence coverage, and confidence use `0..1`; `referenceScore` uses
`0..100`. Unknown metrics must be `null`, not zero.
