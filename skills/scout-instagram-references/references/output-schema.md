# Reference scouting output

Return one `InstagramReferenceContext` object with these sections:

- `query`: Effective topic, objective, region, time range, and format.
- `searchSummary`: Queries executed, verified-reference count, confidence, and
  limitations.
- `references`: Ranked verified Instagram URLs with explicit metrics when
  available, similarity scores, creative analysis, evidence scope, source URLs,
  and confidence.
- `patterns`: Recurring hooks, structures, and visual patterns linked to the
  reference URLs that support them.
- `editorContext`: Adaptable ideas, cautions, and evidence rules.
- `sources`: All URLs returned or cited by web search.

Each reference has this shape:

```json
{
  "rank": 1,
  "instagramUrl": "https://www.instagram.com/p/...",
  "creatorHandle": "string or null",
  "format": "carousel | reel | single_image | unknown",
  "publishedAt": "ISO date or null",
  "topicSummary": "string",
  "observedMetrics": {
    "likes": "number or null",
    "comments": "number or null",
    "views": "number or null",
    "saves": "number or null",
    "shares": "number or null"
  },
  "performanceSignal": "unknown | low | medium | high | viral",
  "metricCaveat": "string",
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

Similarity and confidence use `0..1`. Unknown metrics must be `null`, not zero.
