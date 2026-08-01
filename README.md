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
