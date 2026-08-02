# BMT · Personal Brand Studio

The first web-app skeleton for the personal branding platform:

`onboarding → project brief → idea selection → post review`

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Onboarding brand context

The onboarding screen collects the account name, Instagram ID, desired mood,
main topics, and formats to preserve. `POST /api/onboarding/context` converts
those answers into a structured brand context with separate marketer and editor
instructions.

The browser always persists the result locally. When Supabase is configured and
the visitor is authenticated, it also upserts the profile into
`user_brand_contexts`. Apply
`supabase/migrations/202608010001_create_user_brand_contexts.sql` before enabling
database sync. The table uses row-level security so users can access only their
own context.

The full structured context is sent to both downstream agents:

- the marketer uses it for hooks, content angles, and format decisions;
- the editor uses it for voice, hierarchy, image treatment, and slide flow.

The Instagram ID is stored as account identity for later analysis. It does not
replace Instagram OAuth or the access token required by the Graph API.

## Project assets and content flow

Authenticated projects store user photos and selected Instagram design
references in the private `project-assets` Supabase Storage bucket. Apply
`supabase/migrations/202608020001_create_project_assets.sql` to create the
bucket, `project_assets` metadata table, grants, and owner-only RLS policies.

The creation flow is:

1. Upload user photos and optional descriptions to private Storage.
2. The Marketing Agent decides `topic`/`purpose`/`searchTerms` and calls the
   `scout_instagram_references` tool exactly once. Region (KR), carousel format,
   30-day recency, and reference count are fixed server-side.
3. The Marketing Agent returns exactly two idea cards, each carrying a complete
   per-slide plan (`sourceAssetId`, `imageTreatment`, text, `intent`,
   `imageIntent`, and the references it drew on). There is no separate
   EditorInput planner step — the marketer authors the plan directly.
4. The user selects one idea; its slide plan and references pass straight to the
   Editor Agent.
5. The Editor Agent composes each card in the OpenPencil document from a small
   visual vocabulary: the user photo, an optional full-slide dark overlay,
   opaque lines, and text.
6. On review, optionally upload the final PNG slides under the authenticated
   user's `generated/` Storage prefix.
7. Call `POST /api/instagram/publish` to create each Instagram child media
   container, create the carousel container, wait for processing, and publish.

Slide count follows a guideline rather than a rigid formula: the default is one
slide per user photo in upload order, and the first photo's slide acts as the
cover. The Marketing Agent may add at most one opening and/or one closing slide
when they add real value, so N photos produce N to N+2 slides. Every slide maps
to a user photo through a stable `sourceAssetId` (a photo may repeat only on an
added opening/closing slide), and the Editor validation requires each card to
contain exactly one visible user image matching its slide's `sourceAssetId`;
missing or mismatched images are rejected.

Reference images are multimodal design evidence only and must never be placed
in the finished carousel. Database rows retain storage paths; Agent runs use
short-lived signed URLs.

## Agents

Two agents drive content creation:

- **Marketing Agent** — reads the brief, brand context, and uploaded photos;
  decides the research query and calls `scout_instagram_references` once; then
  returns two distinct idea cards, each with a complete per-slide plan. It works
  only from the brief and visible photos, never inventing venues, menus, prices,
  or metrics, and cites the references each slide drew on.
- **Editor Agent** — turns the selected slide plan into a finished carousel in
  the OpenPencil document. It keeps the small visual vocabulary above, owns the
  craft the plan leaves open (typography, crop, placement, composition), and
  must pass carousel validation before completing.

Both agents also receive the structured onboarding brand context and, when an
owned-account analysis exists, `brandContext.ownedAccountContext`.

Evidence rules shared by both:

- Do not estimate hidden likes, comments, saves, shares, or reach; keep missing
  metrics `null`.
- Use only verified direct `instagram.com/p`, `/reel`, or `/tv` URLs as
  references.
- Separate observation from inference and preserve confidence and limitations.
- Never place a reference image in the final post; reuse only transferable
  principles.

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
OPENAI_MODEL=gpt-5.4-mini
APIFY_API_TOKEN=
INSTAGRAM_ACCESS_TOKEN=
INSTAGRAM_API_VERSION=v23.0
```

`APIFY_API_TOKEN` is a server-only credential for public Instagram reference
discovery. Keep its real value only in `.env.local` and never prefix it with
`NEXT_PUBLIC_`.

`INSTAGRAM_USER_ID` may contain a username for local notes; the runtime resolves
the numeric account ID from the access token. App ID and App Secret are reserved
for the OAuth connection flow.

When onboarding is saved, the app also analyzes the recent 12 posts and up to
20 comments per post from the connected owned account. The evidence-linked
result is saved inside `brandContext.ownedAccountContext`, so Marketer and
Editor receive the account's weak patterns, visual priority fixes, reusable
patterns, limitations, and post IDs with the usual onboarding context. The
submitted Instagram ID must match the account resolved by the configured token;
the app refuses to attach another account's analysis.

Automatic publishing uses the Instagram API with Instagram Login. The token
must belong to a Professional (Business or Creator) account and include
`instagram_business_basic` and `instagram_business_content_publish`. Meta must
be able to fetch every media file from a public URL, so the server creates
one-hour Supabase signed URLs for the private generated images. The UI requires
2–10 fully exported images and asks for confirmation before publishing.

Check the connected publishing account:

```bash
curl http://localhost:3000/api/instagram/publish
```

Run an analysis through the UI or call the API directly:

```bash
curl -X POST http://localhost:3000/api/instagram/analyze \
  -H "Content-Type: application/json" \
  -d '{"postLimit":12,"commentsPerPost":20,"focus":""}'
```

The current Instagram token is server-wide and intended for the connected MVP
account. Supabase authentication protects the route, but a multi-user product
must add Instagram OAuth and encrypted per-user token storage before exposing
account selection publicly.

## Marketer skills

The marketer workflow is defined as two reusable, repo-local skills:

- `skills/analyze-instagram-account`: audits the connected owned account using
  media, comments, insights, and slide images.
- `skills/scout-instagram-references`: uses Apify to discover topic-matched
  public single-image and carousel posts, then ranks verified direct Instagram
  post URLs with evidence-preserving metrics before OpenAI extracts reusable
  creative patterns.

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
  -d '{"topic":"성수동 맛집 추천 카드뉴스","objective":"저장","timeRange":"30d","region":"KR","formatFocus":"carousel","maxReferences":3}'
```

The response includes verified Instagram URLs, search sources, similarity
scores, evidence scope, transferable creative elements, and editor guidance.
Render returned source URLs as visible clickable links in any user-facing UI.

During idea generation the Marketing Agent invokes this same scouting logic as a
one-shot `scout_instagram_references` tool, deciding `topic`/`purpose`/
`searchTerms` itself while the region, format, recency, and count stay fixed.

## Validation

After changing agent code, prompts, or skills, run:

```bash
npx tsc --noEmit
npm run build
```
