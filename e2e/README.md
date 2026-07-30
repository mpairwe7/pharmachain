# End-to-end tests

Five browser suites run against a running stack (local or deployed — set
`E2E_BASE_URL`):

- **`golden-path.spec.ts`** — the Phase 1 golden path: the seeded buyer
  raises an RFQ, the seeded supplier finds it in the quote inbox and quotes,
  the buyer accepts (creating an order), the seller advances the shipment,
  and the buyer sees the new stage plus history.
- **`endpoints.spec.ts`** — read coverage of every API GET across all
  controllers, signed in as an OPERATIONS user, a COMPANY_ADMIN and the
  super admin, plus RBAC / auth / validation negative paths.
- **`regression.spec.ts`** — hardening properties that must not silently
  regress: helmet security headers, no `x-powered-by`, per-client-IP
  throttling, the consistent JSON error envelope, and no account enumeration.
- **`checklist.spec.ts`** — the Phase 1 MVP test-checklist cases that only a
  browser can settle: validation that must fire *before* any API call
  (cases 3, 4), the upload picker's own size and type rejections and the
  upload → "uploaded, pending review" → re-upload-supersedes flow (5–8), the
  comparison tray's 4-item cap and removal (57, 58), the award dialog being
  cancellable without creating an order (79), the notification centre
  (107–109), the shipment tracker (117–119) and idle-session warning and
  expiry driven by a faked clock (36, 37).
- **`routes.spec.ts`** — every major frontend route renders its
  schema-backed content and never falls through to the error boundary.

`helpers.ts` holds the shared plumbing: sign-in, navigation assertions, and
the API base resolution described below.

## Reaching the API

The API sits at two different places depending on how the stack runs, so the
specs resolve it through two knobs:

| | deployed (default) | local stack |
|---|---|---|
| `E2E_API_PATH` | `/api/backend` | `/api/proxy` |
| `E2E_API_ORIGIN` | *(unset — derived from `baseURL`)* | `http://127.0.0.1:3001` |

`E2E_API_PATH` is a same-origin path used from a signed-in browser context so
the session cookie rides along. `E2E_API_ORIGIN` is only for the handful of
assertions that must bypass the web proxy — helmet's headers, the
trusted-proxy IP rules and the raw error envelope — because the proxy
forwards only `content-type`.

## Running locally

```bash
docker compose up -d               # PostgreSQL + MinIO (or any Postgres + S3-compatible store)
bun run db:migrate:deploy && bun run db:seed
bun run --filter @pharmachain/api start &          # api :3001

# The web app builds with output:"standalone", so `next start` will not serve
# it — run the emitted server, and copy the static assets it expects.
bun run --filter @pharmachain/web build
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
cp -r apps/web/public       apps/web/.next/standalone/apps/web/public
(cd apps/web/.next/standalone/apps/web && PORT=3000 node server.js) &

bunx playwright install chromium   # once

E2E_BASE_URL=http://127.0.0.1:3000 \
E2E_API_PATH=/api/proxy \
E2E_API_ORIGIN=http://127.0.0.1:3001 \
E2E_PROXY_SECRET="$AUTH_SECRET" \
bun run test:e2e
```

`NODE_ENV` must **not** be set to `development` for the build — `next build`
expects production and otherwise fails prerendering with
`Cannot read properties of null (reading 'useContext')`.

The API and web app must share `AUTH_SECRET`; the suites sign in with the
seeded demo users (`ops@nilepharma.demo` / `ops@kampalafinechem.demo`,
password from `SEED_DEMO_PASSWORD`, default per `.env.example`).

Two suites need extra environment against a deployed stack:

- `E2E_PROXY_SECRET` (= the deployment's `AUTH_SECRET`) lets the throttle
  spec pin fresh client IPs through the trusted-proxy header the way the web
  tier does; without it the deterministic throttle test skips (the
  spoof-rejection test still runs).
- The golden path tops up the demo companies' freemium allowance through the
  real US-907 credit flow (company admin requests, super admin confirms), so
  repeated runs never dry up the monthly RFQ/quotation limits; the register
  test retires its created company from the verification queue with an
  audited rejection.

## Sessions are reused deliberately

The API throttles logins at 40 per 15 minutes per client IP — a real control
that `regression.spec.ts` asserts. A suite that signed in for every describe
block tripped that limiter and failed with unexplained login timeouts, so
`signIn()` captures each role's session once and reuses it, caching to
`test-results/.auth/` (gitignored) for 20 minutes so a worker restart or a
back-to-back run does not start signing in again. Each caller still gets an
isolated browser context; only the credential round-trip is shared. Use
`signInFresh()` when a test needs the login form itself.

## Coverage notes

- The flow exercises auth, RBAC-gated navigation, marketplace data, the RFQ
  lifecycle, quotation submission, award → order creation, and shipment
  status updates with buyer-visible history.
- Document upload **is** covered end to end (picker rejections, upload,
  checklist state, re-upload versioning) — bytes go to the API, which writes
  to object storage server-side, so no browser-to-bucket CORS setup is needed.
- The suite is single-worker and stateful within a run; every run tags its
  RFQ title with a unique run id, so re-runs against the same database don't
  collide. `checklist.spec.ts` tops the marketplace up to five published
  listings when needed so the comparison cap is always exercised.
