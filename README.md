# BMT · Personal Brand Studio

The first web-app skeleton for the personal branding platform. It currently ships a browser-only control flow with mock Agent responses:

`onboarding → project brief → idea selection → post review`

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The Supabase client and environment variable template are included as integration points. The current demo intentionally runs without credentials so the product flow can be reviewed before the Agent implementations are selected.

## Instagram context model

The MVP includes an Instagram analysis flow at
[http://localhost:3000/analysis](http://localhost:3000/analysis).

It performs the following pipeline:

1. Resolves the connected professional account with `GET /me`.
2. Loads recent media, comments, and media insights.
3. Calculates deterministic reach-normalized engagement baselines.
4. Sends a compact evidence dataset to the OpenAI Responses API.
5. Returns a strict `EditorAgentContext` JSON object with evidence post and
   comment IDs.

Copy `.env.example` to `.env.local` and configure:

```bash
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.6
INSTAGRAM_ACCESS_TOKEN=
INSTAGRAM_API_VERSION=v23.0
```

`INSTAGRAM_USER_ID` may contain a username for local notes; the runtime resolves
the numeric account ID from the access token. App ID and App Secret are reserved
for the OAuth connection flow.

Run an analysis through the UI or call the API directly:

```bash
curl -X POST http://localhost:3000/api/instagram/analyze \
  -H "Content-Type: application/json" \
  -d '{"postLimit":12,"commentsPerPost":20,"focus":""}'
```

The current endpoint is intended for local MVP use. Add application
authentication and per-user token storage before exposing it publicly.

## Marketer skills

The marketer workflow is defined as two reusable, repo-local skills:

- `skills/analyze-instagram-account`: audits the connected owned account using
  media, comments, insights, and slide images.
- `skills/scout-instagram-references`: finds topic-matched public Instagram
  references through OpenAI web search and accepts only verified direct
  Instagram post URLs.

The owned-account analysis endpoint loads the first skill automatically:

```bash
curl -X POST http://localhost:3000/api/instagram/analyze \
  -H "Content-Type: application/json" \
  -d '{"postLimit":12,"commentsPerPost":20,"focus":"다음 카드뉴스 개선"}'
```

Search for references with the second skill:

```bash
curl -X POST http://localhost:3000/api/instagram/references \
  -H "Content-Type: application/json" \
  -d '{"topic":"성수동 맛집 추천 카드뉴스","objective":"저장","timeRange":"30d","region":"KR","formatFocus":"carousel","maxReferences":5}'
```

The response includes verified Instagram URLs, search sources, similarity
scores, evidence scope, transferable creative elements, and editor guidance.
Render returned source URLs as visible clickable links in any user-facing UI.
