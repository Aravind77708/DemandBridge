# DemandBridge

DemandBridge is a Node.js procurement workflow application. The static frontend is in `public/`; `server.js` is the Node HTTP API entry point. PostgreSQL is the production database. Local JSON data remains available for one-time import and is never edited by the importer.

## Local development

Requirements: Node.js 20 or newer. A local persistent PostgreSQL-compatible PGlite database is included for Windows development; no cloud database or PostgreSQL installation is needed.

In terminal 1, start the local database and leave that terminal open:

```powershell
npm install
npm run local:db
```

It listens only on `127.0.0.1:55432` and stores its files in the ignored `.local-pglite/` directory. It supports up to five concurrent client connections for local development. Stop it with Ctrl+C; its data remains on disk for the next run.

In terminal 2, initialize and start DemandBridge:

```powershell
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:55432/postgres'
$env:AUTH_TOKEN_SECRET = (node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
$env:NODE_ENV = 'development'
$env:DEMO_AUTH_ENABLED = 'true'
$env:API_BASE_URL = ''
$env:PORT = '4174' # Port 4173 is already occupied on this computer.
$env:DEMO_ACCOUNT_PASSWORD = Read-Host 'Choose a local demo password (12+ characters)'
npm run db:migrate
npm run db:seed
npm run auth:seed-demo
npm run build
npm start
```

Open `http://localhost:4174`. The UI and API share this local origin, so the generated frontend config uses same-origin API requests. Sign in using one of the five role email addresses described below and the password you entered at the prompt. Sample business data is inserted only if the local database has no demands, suppliers, purchase orders, or shipments; an already populated database is left unchanged.

To create a non-demo local account instead, set `USER_EMAIL`, `USER_ROLE`, and `USER_PASSWORD` in the same terminal environment and run `npm run auth:create-user`. No password or signing secret needs to go into a file or Git.

Create actual accounts through the protected administrative setup command. It reads the password from the environment, hashes it with scrypt, and never prints it:

```sh
USER_EMAIL=manager@example.com USER_ROLE="Procurement Manager" USER_PASSWORD="$A_PRIVATE_PASSWORD" npm run auth:create-user
```

On PowerShell, set `$env:USER_EMAIL`, `$env:USER_ROLE`, and `$env:USER_PASSWORD` for the command, then remove them from the session when finished. Use `auth:create-user` for real accounts; it creates non-demo users and does not update an existing email.

Local demo accounts are explicitly opt-in and cannot authenticate in production. The seeded emails are `buyer@demo.local`, `supplier@demo.local`, `procurement-manager@demo.local`, `logistics-provider@demo.local`, and `administrator@demo.local`. They all use the local password entered above.

For a Unix-like shell, seed demo accounts with a private shell environment value:

```sh
NODE_ENV=development DEMO_AUTH_ENABLED=true DEMO_ACCOUNT_PASSWORD="$A_PRIVATE_PASSWORD" npm run auth:seed-demo
```

This creates five role-specific `@demo.local` users with the supplied shared password. Set `NODE_ENV=development` and `DEMO_AUTH_ENABLED=true` only for local development. The backend rejects demo accounts unless both settings are present, and Render sets `NODE_ENV=production` with demo access disabled.

## Database migrations and existing JSON data

Numbered SQL files in `database/migrations/` are applied in order at server startup and by `npm run db:migrate`. Each migration runs in a transaction under a PostgreSQL advisory lock. The runner records a SHA-256 checksum and refuses to run if an already-applied migration file has changed; add a new numbered migration for future schema changes. Migrations use additive/idempotent operations and do not drop or truncate tables.

The JSON importer validates the source before writing and imports all records in one transaction. Existing IDs are skipped with `ON CONFLICT DO NOTHING`, so rerunning the command cannot overwrite records. The source `data.json` is not changed or deleted.

```sh
# Safe preview; does not connect to or modify PostgreSQL.
npm run db:import-json

# After DATABASE_URL points at the intended database, perform the import once.
npm run db:import-json -- --apply
```

Keep a private backup of the JSON file before migration. The importer only reads `data.json` from the project root; set `IMPORT_FILE` to import a different JSON file. Do not commit production exports or database URLs.

## Environment variables

| Variable | Used by | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Backend | PostgreSQL connection URI. Use Neon’s pooled connection string for the long-running Render service. Secret; configure only in local `.env` and Render. |
| `CORS_ORIGINS` | Backend | Comma-separated exact browser origins allowed to call the API, including `https://your-project.vercel.app` and any custom domain. |
| `API_BASE_URL` | Frontend build | Render backend origin, such as `https://demandbridge-api.onrender.com`, without a trailing slash or `/api`. This is public browser configuration, not a credential. |
| `PORT` | Backend | HTTP port. Render supplies it; local default is `4173`. |
| `PG_POOL_MAX` | Backend | Optional maximum PostgreSQL pool size; defaults to `5`. |
| `IMPORT_FILE` | Import script | Optional JSON input path; defaults to project-root `data.json`. |
| `AUTH_TOKEN_SECRET` | Backend | Required signing key for 15-minute HMAC-SHA256 bearer tokens. Generate at least 32 random bytes. Keep only in local `.env` and Render. |
| `DEMO_AUTH_ENABLED` | Backend | Defaults to off. Demo users are accepted only when this is `true` and `NODE_ENV=development` or `test`; never enable for production. |

Never put `DATABASE_URL` or other secrets in Vercel frontend variables, `API_BASE_URL`, source files, or Git. `.env.example` contains placeholders only.

## Hosting limits and production suitability

The zero-cost provider tiers support a public demonstration, but this exact hosting combination is **not production-ready**:

- Render Free documentation says not to use Free instances for production. The web service sleeps after 15 minutes without traffic, can take about a minute to wake, has an ephemeral filesystem, and cannot attach a persistent disk. The free plan also has monthly instance-hour, bandwidth, and build limits. Do not store application state on its local filesystem. See [Render Free service limits](https://render.com/docs/free).
- Vercel Hobby is restricted to non-commercial, personal use. A business or revenue-generating deployment requires an eligible plan. See [Vercel Hobby plan](https://vercel.com/docs/plans/hobby).
- Neon Free currently includes 100 CU-hours and 1 GB PostgreSQL storage per project, scales compute to zero after five minutes, offers one manual snapshot, and does not include a production SLA or scheduled backup. Monitor the limits before using it for a public demo. See [Neon plan limits](https://neon.com/docs/introduction/plans).

Use these free plans for a non-commercial demonstration with synthetic or approved sample data. A real production service needs hosting and database tiers appropriate for production, backups and recovery procedures, and tenant-level data access controls. No paid plan is selected or purchased here.

## Deploy the backend to Render Free (demonstration only)

1. Create a Neon project for a demonstration database. Do not reuse the previously exposed Neon password; rotate it before connecting any service. Use the current pooled PostgreSQL URL in Render's secret settings only.
2. For data migration, first make a private backup of the original JSON file. Test migrations and import against a disposable branch. Do not point test commands at production. The importer is additive and skips existing IDs, but it does not replace a backup/restore plan.
3. Import the GitHub repository as a Render Blueprint and select `render.yaml`. The configuration uses the project root, `npm ci && npm run build`, `npm start`, and `/api/health`.
4. In Render, set `DATABASE_URL`, `AUTH_TOKEN_SECRET`, and `CORS_ORIGINS`. `CORS_ORIGINS` must contain only the exact deployed Vercel origin, for example `https://your-project.vercel.app`. Keep `NODE_ENV=production` and `DEMO_AUTH_ENABLED=false`. Render supplies `PORT`.
5. Create a production user out of band with `USER_EMAIL`, `USER_ROLE`, and `USER_PASSWORD` using `npm run auth:create-user`. Do not enable or seed demo accounts on the deployed service.
6. Verify `https://<render-service>.onrender.com/api/health` returns `ok: true` and `db: postgres`.

The Render Free service is suitable here for a demonstration only. It can sleep, restart, or lose its local filesystem, and Render explicitly excludes Free web services from production use. Business records must stay in PostgreSQL.

## Deploy the frontend to Vercel

1. Import the GitHub repository into Vercel with the repository root as the project root.
2. Keep `npm run build` as the build command and `public` as the output directory from `vercel.json`.
3. Set the public build variable `API_BASE_URL` to the HTTPS Render service origin, with no trailing slash or `/api`, for example `https://demandbridge-api.onrender.com`.
4. Deploy the frontend, copy its exact production origin, and put that origin in Render `CORS_ORIGINS`. Restart/redeploy the backend after changing CORS.
5. Verify the login page loads, `/api/health` is healthy, and the browser can reach the Render API without CORS errors.

Vercel only hosts the static frontend. The Node API remains on Render. No Vercel serverless API or local JSON persistence is involved. Vercel Hobby is for personal non-commercial use only; use an appropriate plan if this app is for a business.

## Demand-specific supplier matching

Matching is rule-based feasibility filtering followed by a weighted supplier ranking; it is **not a trained AI model**. A supplier must be verified, list the exact normalized demand item in its catalog, match a requested category when one is supplied, meet every recorded quality requirement, have positive capacity in the same unit as the demand, satisfy its MOQ, and meet the demand deadline. Eligible suppliers may be combined; the engine creates an MOQ-valid suggested split only when a complete allocation is possible.

The `/api/match/:id` response retains `demand` and `matches`, with additional `excluded`, `summary`, and `allocationPlan` fields. Eligible and excluded suppliers include human-readable reasons; eligible entries include a weighted score breakdown. Scoring weights are product match 25, requested category 15, mandatory quality 20, capacity fit 15, price 10, lead-time slack 10, rating 5, and distance 5. Scores are normalized over the applicable factors. Location affects ranking only when both supplier and destination coordinates are recorded; otherwise the response explains that distance was not scored. The UI exposes optional category, quality JSON, product catalog, MOQ, units, and coordinates. Unknown legacy catalog/quality/location values remain unknown and do not get invented: suppliers without an exact catalog item are excluded until verified product information is added.

Migration `004_demand_specific_matching.sql` adds these demand and supplier attributes with defaults so existing records remain readable. Existing data is not overwritten. The importer copies these attributes only when present in the source JSON and otherwise leaves safe empty/default values.

## UI and capability boundaries

Navigation and visible workflow actions are tailored to the signed-in role. Suppliers can correct and resubmit rejected profiles and catalogue products; changes remain pending until administrator review. Dashboard charts and summaries are computed from the records visible to the role; delivery punctuality is not shown because the database does not store actual delivery timestamps. Logistics displays origin, destination, ETA, and status, but does not include live geocoding or a map. The Administration screen is an audit/status view, not account management. Matching is explainable rule-based filtering and weighted ranking, not a trained AI or machine-learning service.
## API and workflow

The existing routes and response formats are retained, with supplier resubmission at `PATCH /api/suppliers`: `/api/health`, `/api/bootstrap`, `/api/suppliers`, `/api/audit`, `/api/demo-login`, `/api/demands`, `/api/match/:id`, `/api/allocate`, `/api/orders/:id/approve`, and `/api/shipments` (POST and PATCH by ID). `/api/demo-login` verifies an email/password and returns a signed 15-minute bearer token; the role is read from the database, never trusted from the browser. All API routes except `GET /api/health` and `POST /api/demo-login` require a valid bearer token. Buyer demands and related orders are scoped to the authenticated buyer; suppliers see only their own catalogue; logistics receives shipment workflow data; procurement and administrators receive operational data. The public supplier directory and non-admin matching results include approved suppliers/products only. Audit data is omitted from the bootstrap response for roles without audit access.

Passwords use Node.js scrypt hashes with per-user random salts. `AUTH_TOKEN_SECRET` is mandatory at server startup. Provision accounts out of band with `npm run auth:create-user`; there is no public registration endpoint. Procurement allocation locks the demand and available supplier rows, reserves capacity and writes the PO, allocations, demand status, and audit record in one transaction. A unique database index enforces one PO per demand. Suppliers can be combined to satisfy a demand; if their total capacity is insufficient, the request returns 422 and leaves all capacities and records unchanged. Existing order allocations are applied to available capacity by migration 003 and by the JSON importer. If legacy data contains duplicate POs for one demand, the unique-index migration stops and rolls back without deleting records; resolve those duplicates before retrying migrations.

Signed tokens are stored in browser local storage and expire after 15 minutes; users sign in again after expiry. Login has an in-memory limit of ten failed attempts per normalized email in 15 minutes; it resets on process restart and is not shared across instances. This is a basic brute-force speed bump, not a distributed abuse-control system. The service also sends CSP, frame, MIME sniffing, referrer, permissions, and production HSTS headers. There is no refresh-token flow, password reset, or in-app user administration. Migration 006 adds buyer ownership for new buyer-created demands; existing demands retain a null owner and remain accessible to procurement managers and administrators, but are not disclosed to individual buyer accounts. Tenant-level organization controls are not implemented.

## Tests

```sh
npm test
npm run build
```

The tests use a separate PostgreSQL-compatible PGlite database by default. They cover password login, signed/missing/invalid/expired tokens, role checks and response filtering, login throttling, security headers, input validation, CORS, the procurement workflow, competing allocations, insufficient capacity, transaction rollback, migration idempotence, importer non-overwrite and catalogue-capacity reservation, and unchanged local `data.json`. PGlite uses one pooled database connection in the default test run, so it does not model two PostgreSQL sessions contending for row locks. For that verification, set `DEMANDBRIDGE_TEST_DATABASE_URL` to a disposable PostgreSQL test database using a direct (non-pooled) URI, then run `npm test`; the suite creates and drops only a uniquely named temporary schema and uses a five-connection pool. Never point it at production. No PostgreSQL multi-session run is claimed unless that command is actually executed.
