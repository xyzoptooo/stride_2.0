# Backend Environment Configuration

This file documents environment variables that affect rate limiting, concurrency, and upload limits.

Important variables

- `PORT` - port the server listens on (default: `3000`)
- `NODE_ENV` - `development` or `production`
- `MONGODB_URI` - MongoDB connection string (required)
- `OPENAI_API_KEY` - OpenAI API key (required for AI features)

Upload and size limits

- `MAX_FILE_SIZE` - request body size accepted by express.json / urlencoded. Accepts values like `10mb`, `50mb`. Default: `50mb`.

Rate limiting

- `RATE_LIMIT_WINDOW_MS` - rate limit window size in milliseconds. Default: `900000` (15 minutes).
- `RATE_LIMIT_MAX` - number of requests allowed per IP per window. Default: `100`.

Concurrency (OCR/OpenAI)

- `OCR_CONCURRENCY` - number of concurrent heavy tasks (OCR/OpenAI) the server will run in-process. Default: `2`.

Notes

- These defaults are conservative for a small single-instance deployment. For real-user scale, consider moving heavy tasks to an async queue (Redis + workers) and using a distributed rate limiter.
- Do not commit secrets to the repository. Use your hosting provider's secret manager.

Smart reminders & push notifications

- `REMINDER_ENCRYPTION_KEY` – 32-byte base64 string used to encrypt reminder metadata at rest. Required in production.
- `WEB_PUSH_VAPID_PUBLIC_KEY` / `WEB_PUSH_VAPID_PRIVATE_KEY` – VAPID key pair used for web push subscriptions. Required in production when smart reminders are enabled.
- `SMART_REMINDERS_DISABLED` – set to `true` to temporarily disable reminder scheduling and push notifications (not recommended for long term).

Generate new keys locally by running:

```
npm run generate:reminder-keys
```

The script will print all three values; copy them into your hosting provider's environment settings (e.g., Render → Environment → Environment Variables) before deploying.

Onboarding draft flow

- The onboarding import endpoint supports anonymous preview uploads when `ALLOW_ANON_ONBOARDING` is true (default). When a user uploads before logging in, the server returns parsed data but does not persist it. The frontend saves this as `onboarding_draft` in localStorage.
- After the user completes login/sign-up, call the `POST /api/onboarding/finalize` endpoint with the parsed draft (or call the helper injected into `window.finalizeOnboardingDraft()` by the frontend component) to persist the parsed courses and assignments to the authenticated user's account.

Redis draft store

- To store drafts server-side, set `REDIS_URL` (or `REDIS_URI`) in your environment. When configured, anonymous onboarding previews are saved in Redis with a TTL controlled by `DRAFT_TTL_SECONDS` (default 86400 seconds = 24 hours).
- The server returns a `draftId` to the client which the client should pass to `/api/onboarding/finalize` after login. If Redis is not configured, the server will return a preview without a `draftId` and the client will need to handle local persistence.

