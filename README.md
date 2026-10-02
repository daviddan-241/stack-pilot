# StackPilot — AI code-to-deploy workspace

A responsive, single-operator workspace that turns a pasted code dump into a project file tree, validates it, pushes it to GitHub, runs build/test checks in a temporary GitHub Actions runner, and can create or redeploy a Render service after checks pass.

## Current architecture

- **Claude / Anthropic** organizes a pasted dump and can attempt up to two targeted repairs from actual build logs. A key is required.
- **GitHub** stores the durable source. A push is an atomic Git commit. StackPilot adds `.github/workflows/stackpilot-ci.yml` to run supported Node, Python, Go, Ruby, Elixir, or Rust checks on push.
- **Remote shell** dispatches a command to a temporary GitHub-hosted Actions runner. It is not a shell process inside the Render web service. The runner does not receive StackPilot's stored keys; `actions/checkout` is configured with `persist-credentials: false`. GitHub Actions permissions and usage limits still apply.
- **Render** service creation happens only after GitHub checks pass. StackPilot polls deployment status and Render logs, then shows the service URL. Render must already have access to the selected GitHub repository.
- **Persistence**: unsent drafts and project metadata live in this browser's IndexedDB. GitHub is the durable, cross-device copy after a push. API keys are held in browser `sessionStorage` for the current session and forwarded only when an action is requested; the app does not write them to its project files.
- **Preflight**: checks path safety, `package.json`, relative imports, and likely embedded credentials. Actual build/test is done remotely in GitHub Actions. No software can promise that every generated project is error-free; check the logs and preview before relying on a deployment.

## Run locally

Requirements: Node.js 20+

```bash
npm install
cp .env.example .env
npm run dev
```

Open the URL printed by the server. The app listens on `0.0.0.0` so it can also be opened from another device on the same trusted network. Do not forward a local dev server to the public internet.

For a production build:

```bash
npm run build
NODE_ENV=production npm start
```

## Deploy this app to Render

1. Create a new GitHub repository for **this StackPilot project** and push these files.
2. In Render, create a Web Service from that repository. You can use the included `render.yaml` Blueprint or set:
   - Build command: `npm install && npm run build`
   - Start command: `npm start`
   - Health check: `/api/health`
   - Plan: Free (for a personal preview)
3. Set a long, private `APP_PASSWORD` in Render. The included Blueprint asks Render to generate one; retrieve it from the service's Environment page and enter it under **Connectors** when you open StackPilot.
4. Open the StackPilot URL, then add your Anthropic API key, GitHub token, and Render API key/workspace ID in **Connectors**.
5. Link the GitHub account to Render in the Render dashboard before asking StackPilot to create a Render service from a private repo.

## Credentials needed

- **Anthropic**: an API key with access to the selected Claude model. Usage is billed by Anthropic.
- **GitHub fine-grained token**: repository **Contents: read/write**, **Actions: read/write**, and **Metadata: read**. Add repository-creation permission if you want StackPilot to create repos automatically. Alternatively create a private repo yourself and enter `owner/repo`.
- **Render**: a Render API key plus the workspace/owner ID. Render must be linked to the GitHub repository. Select Static Site or Web Service and review the build/start commands before release. Web services default to Frankfurt (editable in the workspace); static sites use Render's global CDN.

Tokens are not saved in Render's environment by this app. They are stored only in the current browser session. Use a private device, keep `APP_PASSWORD` enabled on a public deployment, and revoke any key you accidentally expose.

## Important Render Free limitations

Render Free web services can spin down after 15 minutes without inbound traffic; local filesystem changes are lost on spin-down, restart, and redeploy. This is why drafts live in browser storage and source is pushed to GitHub. Free services are appropriate for demos and personal experiments, not a promise of always-on production hosting. See [Render's Free instance documentation](https://render.com/docs/free).

## Notes

- The app does not store project drafts on its server. On iOS, use Safari and avoid clearing website data; push projects to GitHub to access source from another device.
- GitHub Actions is a temporary CI/shell runner, not a persistent interactive VM. Detailed job logs are available after GitHub archives the run; status is polled while the job runs. A shell command can read the checked-out repository and access the network, so run only source you trust; the runner is not an interactive production shell.
- Never place production secrets in a code dump. Use environment variables configured on Render instead.
- The `render.yaml` file is for deploying StackPilot itself. It does not create other user services until you trigger a pipeline from the UI.
