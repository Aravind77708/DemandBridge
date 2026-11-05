# DemandBridge

DemandBridge is currently a dependency-free Node.js web app. The frontend is served from `public/`; `server.js` is the backend entry point and serves both the UI and `/api` endpoints. There is no FastAPI application and no Python runtime is used.

## Project and deployment layout

- Frontend root: `public/` (`index.html`, `app.js`, `style.css`, generated `config.js`).
- Backend root / entry point: project root, `server.js`.
- Data store: `data.json` local JSON persistence. Set `DATA_FILE` to a mounted disk path in production. `database/schema.sql` is a PostgreSQL reference schema; the current server does not connect to PostgreSQL.
- Node: 20 or newer. No third-party npm packages are required.
- `requirements.txt` is not applicable because this project has no Python/FastAPI backend.

## Run locally

```sh
npm run build
npm start
```

Then open http://localhost:4173. Copy `.env.example` to `.env` to configure local values. The app loads that file without an added dependency. Do not commit `.env`.

## Environment variables

- `API_BASE_URL` (optional): backend origin used by the browser. Leave blank when the frontend and backend share one origin. For separately hosted frontend, set this to the backend URL, such as `https://your-api.onrender.com` (no `/api` suffix). This is public configuration, not a secret.
- `CORS_ORIGINS` (optional): comma-separated exact origins allowed to call the API. For separate frontend hosting, add its full origin, such as `https://your-ui.onrender.com`. Localhost origins are allowed by default.
- `DATA_FILE` (optional): JSON data file path. Use a persistent mounted disk path in deployment.
- `PORT` (optional): HTTP port. Render supplies this automatically.

Do not put passwords, database credentials, or API keys in frontend configuration. The current app does not use external credentials or connect to a database service.

## Deploy to Render

This repository includes `render.yaml` for a single Node web service. In Render, choose **New → Blueprint**, connect the Git repository containing this folder, and apply the blueprint. It builds with `npm run build`, starts with `npm start`, checks `/api/health`, and mounts a persistent disk at `/var/data` for `data.json`.

The blueprint uses a Starter instance and a 1 GB persistent disk so user-created records survive deploys; Render charges for these resources. Review the current Render pricing before creating the service. Set `CORS_ORIGINS` to the exact deployed frontend origin if you host the UI separately. If you use the single service in this blueprint, frontend and API share an origin and `API_BASE_URL` stays blank.

After deployment, open the service URL and verify `/api/health` returns `{"ok":true,...}`. Keep `.env`, `data.json`, and credentials out of Git. Render injects `PORT`; do not hardcode it.

## Vercel

No `vercel.json` is included. The app uses a long-running Node HTTP server and writes persistent data to a file, so a Vercel serverless deployment would need a separate serverless adapter and external persistent database. Render is the configured deployment target for this project.

## Workflow and demo access

Buyer creates demand → supplier matching ranks verified suppliers → allocation proposes a purchase order → procurement approval → shipment coordination → dashboard and audit activity. Demo sign-in allows role selection but is not production authentication.
