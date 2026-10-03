# StackPilot — AI Build Studio

StackPilot is an iPhone-first, chat-style build studio that accepts a prompt, direct file/image/media attachments, source ZIPs, or existing GitHub repositories. It opens an editable project workspace, runs real GitHub Actions checks, and can deploy to Render **only after the current GitHub checks pass**. It also includes per-project uptime and Render panels, searchable recent builds and complete project history, PWA install assets, and optional Web Push notifications.

## Release paths

1. **Prompt / attachments / ZIP:** paste complete text without an app-level character cap, attach common images (including iPhone HEIC), text/source files, audio, video (including MOV), PDFs, or common Word/Excel/PowerPoint/OpenDocument files, or import up to 100 ZIP archives in one selection (100 MB compressed per archive, 150 MB combined compressed; 2,000 supported files, 8 MiB/file, 25 MiB extracted total). ZIPs and direct attachments accumulate; duplicate standalone filenames are renamed to keep both copies, while same-path ZIP replacements require removing the existing file first. The JSON API body is still capped at 64 MiB. Generated folders, unsafe paths, `.env` secrets, and unsupported binary formats are skipped; oversize supported files stop the import instead of being silently dropped. Possible live credentials are rejected.
2. **Existing GitHub repo:** select a branch, import up to 2,000 safe text/common binary files (8 MiB/file, 25 MiB total), inspect/edit them in the workspace, then run checks. Very large/truncated GitHub trees still need to be split or imported selectively.
3. **GitHub only:** turn Auto-deploy off. StackPilot pushes and waits for the real GitHub Actions build/test workflow, then leaves the verified commit for review.
4. **GitHub + Render:** turn Auto-deploy on. No Render deployment is queued until GitHub checks pass. When you attach an existing Render service ID, StackPilot uses the Render API to turn off that service's native push-triggered auto-deploy before writing to GitHub, then queues a manual deploy only after the checks pass. This requires a Render key. Otherwise, StackPilot can create a new service after checks with valid credentials and workspace settings. Services independently linked outside StackPilot are not controlled unless their service ID is provided.

The project workspace includes an editor, preview, actual operation logs (including GitHub job and step transitions), temporary GitHub-hosted shell runner, per-project environment values, and a release gate. Percent progress advances only when a stage has a confirmed result; running/skipped work is shown separately. The shell is **not** a persistent Render shell; it runs trusted commands on GitHub-hosted VMs.

## OpenRouter free models

- The code organizer and bounded repair flow use OpenRouter's `openrouter/free` router only. The server rejects paid model IDs and never falls back to a paid model.
- One or two OpenRouter keys can be entered for the browser session or saved privately as `OPENROUTER_API_KEY_1` and `_2` in Render. Requests rotate between keys and try the second on eligible auth/quota/transient failures.
- Two keys do **not** guarantee more account quota—keys on the same account can share limits. Free models may be unavailable, slow, or rate-limited; StackPilot cannot promise zero errors or unlimited $0 inference.
- The organizer runs only when pasted instructions need structuring; file-only imports skip that model call. Image and media attachments are preserved as project assets but are not visually analyzed by the text-only organizer. Short requests and text trees that fit are sent complete in one request; larger text intake is losslessly segmented and every segment must receive a model response before synthesis or GitHub release. Review notes may be condensed for synthesis, so a free model can still omit details. If any segment/review call fails or quota runs out, the run stops before pushing and the original input remains in the project. The 64 MiB request-body cap, 25 MiB file-tree cap, browser storage/memory, provider context, quota, and latency are real limits—there is no promise of infinite capacity. Automatic repairs remain capped at two per run and require a smaller text-source context; oversized repair attempts fail explicitly rather than being silently truncated.

## URL monitors

Each project has its own Uptime tab for its Render URL and any additional public HTTP(S) endpoints, without sending cookies or credentials. Project cards also show Render and monitor state. The Monitor page can show all endpoints together. StackPilot records status, HTTP code, latency, recent checks, uptime percentage, and current up/down duration in this browser. Checks run at a minimum 60-second interval **while StackPilot is open and visible**; the local history is not an external monitoring service and stops when the browser is closed. This repository also includes a secret-free GitHub Actions probe that checks the production `/health` endpoint hourly and writes the actual HTTP result and latency to the workflow run log. It becomes active once the workflow is pushed to the repository's default branch; GitHub may delay scheduled runs. This is not an UptimeRobot monitor and does not keep a Render Free service continuously awake. StackPilot's public health endpoint is `/api/health` (or plain `/health`). No UptimeRobot account/API access is included.

## Security and storage

- API keys are not added to project files or commits. Unsaved GitHub, Render, OpenRouter, and app passcode values stay in page memory only and clear on refresh; they are not written to browser storage. The Settings screen has explicit server-save actions for the Render API key, GitHub PAT, and OpenRouter keys; saved values live in StackPilot's Render environment, not browser storage.
- When `APP_PIN` or `APP_PASSWORD` is configured, a dedicated full-screen passcode gate appears before workspace content. The optional `APP_PIN` must be exactly four digits and overrides `APP_PASSWORD`. A PIN is weaker than a long passphrase; the in-process failed-attempt limiter can reset on Render restarts.
- Settings can write the Render API key itself, GitHub/OpenRouter keys, and the App PIN to the StackPilot Render service through the Render API, then queue a deploy. Saving the Render API key requires a valid key with access to the StackPilot service and the configured StackPilot service ID. The restart may take time on Render Free; unsaved fields remain tab-only.
- Project-specific GitHub, Render, and OpenRouter overrides can be saved under project-scoped variable names in the StackPilot service's Render environment; the backend resolves them by project ID, and Render stores them as environment secrets. Saving needs a Render API key with access to the StackPilot service and queues a restart. Unsaved values stay in page memory only, are not encrypted in the browser, and could be inspected from an unlocked tab. Runtime app environment values are sent to that project's own Render service when saved. Do not put platform-account keys in a deployed project's runtime environment. Project drafts are stored in browser IndexedDB; GitHub is the durable source copy after push.
- `/health` and `/api/health` are public for monitoring and do not expose credential values.
- Web Push uses VAPID keys in the server environment. On iPhone, use Safari, add StackPilot to Home Screen, then enable notifications (iOS 16.4+).

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

1. Push this source to GitHub and create a Render Web Service (or use `render.yaml`).
2. Keep `APP_PASSWORD` as a long bootstrap password, or privately set `APP_PIN` to a four-digit code after the app is deployed.
3. Configure `STACKPILOT_SERVICE_ID`, `RENDER_OWNER_ID`, and VAPID keys. Add fresh GitHub and Render API keys through Settings. Add one or two OpenRouter keys if you want the free organizer/repair functions.
4. Use `/health` or `/api/health` for external uptime checks. The monitor page itself is browser-based and not a replacement for an external service.
5. Add StackPilot to Home Screen in iOS Safari, then enable notifications.

## GitHub permissions

Use a fresh fine-grained PAT with Contents read/write, Actions read/write, and Metadata read. Add repository-creation permission only if StackPilot should create repositories. Private repository import requires access to that repository.

## Render Free caveats

Free Web Services can spin down after inactivity and use ephemeral filesystems. The hourly GitHub Actions probe records availability and latency but is not a keep-alive scheme; the service can sleep between checks, and a probe may incur a cold start. No ping cadence can guarantee always-on hosting, durable in-memory jobs, persistent monitor history on the server, or protection from restarts/free-hour limits. Browser-based checks also stop when their page is closed. See [Render Free instance documentation](https://render.com/docs/free).
