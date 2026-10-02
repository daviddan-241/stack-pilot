# StackPilot — AI Build Studio

StackPilot turns a pasted code dump or brief into an editable project workspace, commits source to GitHub, runs real build/test checks, and can publish to Render only after GitHub checks pass. The iPhone-friendly PWA includes a live specialist progress view, job logs, project files, a live deployment preview, optional Web Push notifications, and a public UptimeRobot health endpoint.

## How a build runs

1. **Project Architect** uses Claude to organize a code dump (or resumes from saved files).
2. **Safety & Build Guard** checks paths, likely secrets, imports, and basic project setup.
3. **GitHub Release Agent** commits the project and CI workflow.
4. **Build & Test Agent** watches the real GitHub Actions workflow.
5. **Render Operator** starts only after the current GitHub build/test run succeeds, unless Auto-deploy is off.

The background orchestration is server-side, so closing Safari does not cancel a job while the StackPilot service process stays up. GitHub Actions continues its own build independently after a commit. **Render Free is not a durable job-worker plan**: a service restart/redeploy can clear in-memory job progress and push subscriptions. UptimeRobot requests to `/health` can prevent idle spin-down when sent often enough, but cannot prevent maintenance/restarts or free-hour limits.

## Security and storage

- API credentials are never added to project files or commits.
- The global GitHub PAT can be supplied in the browser session or saved as the private `GITHUB_TOKEN` environment variable from Settings. Its expiry date must be entered manually; GitHub does not return a PAT expiry date through the regular `/user` endpoint. StackPilot can remind you at 7, 3, 1, and 0 days when the date is configured.
- Global `ANTHROPIC_API_KEY` and `RENDER_API_TOKEN` environment variables are optional. Otherwise, credentials are entered in Settings. Project-specific platform overrides and project runtime environment values are kept in browser session storage; runtime variables are sent to Render only when deploying.
- Unsent projects are saved in this browser's IndexedDB. GitHub is the durable, cross-device source copy after push. Avoid clearing website data before pushing drafts.
- `APP_PASSWORD` protects API routes. `/health` and `/api/health` are deliberately public for availability monitoring; they do not expose keys.
- Web Push uses VAPID keys in the server environment. On iPhone, use Safari, add StackPilot to Home Screen, then enable Notifications from inside the installed app (iOS 16.4+).

## Run locally

Requirements: Node.js 20+

```bash
npm ci
cp .env.example .env
npm run dev
```

For a production build:

```bash
npm run build
NODE_ENV=production npm start
```

## Deploy StackPilot to Render

1. Push this source to a GitHub repository.
2. Create a Render Web Service from that repository (or use `render.yaml`).
3. Configure a long private `APP_PASSWORD`. For the full features, also set `STACKPILOT_SERVICE_ID`, `RENDER_OWNER_ID`, and VAPID keys. Optional global credentials are `GITHUB_TOKEN`, `GITHUB_TOKEN_EXPIRES_AT` (`YYYY-MM-DD`), `ANTHROPIC_API_KEY`, and `RENDER_API_TOKEN`.
4. Use `/health` as the service health check and UptimeRobot monitor target. It returns HTTP 200 with plain `ok`; `/api/health` returns JSON and is also public.
5. Add to Home Screen in iOS Safari, then open the new icon and enable notifications.

## Integrations

- **Anthropic**: API key with access to the selected Claude model. Usage is billed by Anthropic.
- **GitHub**: fine-grained PAT with Contents read/write, Actions read/write, and Metadata read. Add repository creation permission only if StackPilot should create repos. The repository can be entered as `owner/repo`.
- **Render**: API key and workspace/owner ID. Render must already be linked to the selected GitHub repo. Per-project environment values are sent through the Render API and are not committed to GitHub.
- **GitHub Actions shell**: runs a command on a temporary runner, not as a persistent shell inside Render. It can read the repository and access the network; run only trusted project code.

## Render Free caveats

Free Web Services can spin down after 15 minutes without inbound requests and have ephemeral filesystems. UptimeRobot can ping `/health` to keep the service warm, but it does not provide durable storage or prevent host restarts. Free instance hours are shared across the workspace. See [Render Free instance documentation](https://render.com/docs/free).
