# Account analysis output

Return one `EditorAgentContext` object:

```json
{
  "schemaVersion": "1.0",
  "generatedAt": "ISO-8601 timestamp",
  "source": "instagram",
  "account": {
    "id": "string",
    "username": "string",
    "accountType": "string",
    "followersCount": "number or null",
    "totalMediaCount": "number or null"
  },
  "coverage": {
    "analyzedPostCount": "number",
    "analyzedCommentCount": "number",
    "postsWithReach": "number",
    "analyzedImageCount": "number",
    "warnings": ["string"]
  },
  "baseline": "deterministic account metrics",
  "analysis": {
    "accountSummary": "positioning, audience, tone, topics",
    "performanceSummary": "evidence-linked winning and weak patterns",
    "audienceResponse": "comment themes and audience language",
    "visualAnalysis": "slide findings, carousel flow, priority fixes",
    "editorContext": "do more, avoid, copy and visual guidance",
    "dataQuality": "coverage and limitations"
  },
  "evidencePosts": ["post metadata and authoritative metrics"]
}
```

Confidence values use the range `0..1`. Visual scores use `0..100`. Never put
credentials, image binary data, or full provider payloads in this object.
