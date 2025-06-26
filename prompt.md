# Pikachu – GitHub ↔ OpenProject Helper

A Bun-powered TypeScript micro-service that listens to GitHub webhooks and posts comments to matching OpenProject work packages when branches are created.

---

## What it does

1. Exposes a single HTTP endpoint (default `/` on port `3000`).
2. Validates GitHub webhook signatures (HMAC SHA-256) — can be disabled.
3. Detects the OpenProject work-package ID from branch names *or* PR titles
   * `op/<id>-…` (e.g. `op/12-feature/awesome`)
   * `[op-<id>] …` (legacy support)
4. Automatically posts activity comments to the work package when:
   * a matching branch is *created*
   * commits are *pushed* to that branch
   * a pull-request is *opened / reopened / marked ready*  ➜ comment with PR link
   * new **comments** are added to that pull-request
   * the pull-request is *merged* ➜ comment & status update
5. On merge the helper sets the work-package status to **Developed** (configurable).
6. Offers a health probe at `GET /health`.
7. Streams all console output to **stdout** _and_ to a rotating file (`server.log` by default).

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | ✖︎ | `3000` | Port to listen on. |
| `OPENPROJECT_BASE_URL` | ✔︎ | – | Base URL of your OpenProject instance, _without trailing slash_. |
| `OPENPROJECT_API_KEY` | ✔︎ | – | API key of the OpenProject user/bot. |
| `GITHUB_WEBHOOK_SECRET` | ✔︎ when `ENFORCE_GITHUB_SIGNATURE=true` | – | Shared secret configured on GitHub webhook. |
| `ENFORCE_GITHUB_SIGNATURE` | ✖︎ | `true` | Set to `false` to skip signature verification (useful for local testing). |
| `LOG_FILE` | ✖︎ | `server.log` | Path to log file. |
| `DEVELOPED_STATUS_NAME` | ✖︎ | `Developed` | The exact status name to apply on PR merge. |
| `DEVELOPED_STATUS_ID` | ✖︎ | – | Skip lookup and use this status id directly. |
| `DISCORD_WEBHOOK_URL` | ✖︎ | – | Discord Incoming Webhook URL to send WP status notifications. |

---

## Quick start

```bash
# 1. Install type stubs (once)
bun install

# 2. Run
OPENPROJECT_BASE_URL="https://openproject.example.com" \
OPENPROJECT_API_KEY="XXXXXXXX" \
GITHUB_WEBHOOK_SECRET="mysecret" \
bun run server.ts
```

The server will print:

```
🚀 Pikachu helper listening on port 3000
```

Make a request to `http://localhost:3000/health` and you should receive `{ "status": "ok" }`.

---

## Configure GitHub webhook

1. Go to **Settings → Webhooks** in your repository (or organization).
2. **Payload URL**: `http(s)://<server-host>:<port>/`
3. **Content type**: `application/json`.
4. **Secret**: same as `GITHUB_WEBHOOK_SECRET`.
5. **Events**: select
   * **Branch or tag creation**
   * **Pushes**
   * **Pull requests**
   * **Pull request reviews** (optional, for review-comments)
   * **Issue comments**

   or simply choose **"Send me everything"**.

---

## Branch naming convention

| Example branch name | Extracted WP ID |
|---------------------|-----------------|
| `op/42-fix/typo` | 42 |
| `feature/op/99-shiny` | 99 |
| `[op-7] hotfix` | 7 |

When GitHub reports the branch-creation event, the server will leave a comment like:

> Branch `op/42-fix/typo` created in GitHub repository `my-org/my-repo`.

---

## Logging

All `console.log`, `console.warn`, and `console.error` lines are:

* Printed to the terminal (stdout/stderr).
* Appended to the file specified by `LOG_FILE`.

The service also prints the full request/response when talking to OpenProject, so you can diagnose authentication or permission issues quickly.

---

## Disabling signature verification (local dev)

```bash
ENFORCE_GITHUB_SIGNATURE=false bun run server.ts
```

---

## Production advice

* Run behind HTTPS (GitHub requires TLS for webhooks).
* Store secrets in a secure vault or environment manager.
* Use a reverse proxy (e.g. Caddy, Nginx) for TLS termination and basic rate-limiting.
* Rotate the `LOG_FILE` with `logrotate` or similar to prevent disk bloat.

---

## Pull-Requests & commits

* **Branch created** → 🔀 comment with branch link.
* **Commit pushed** → 📦 comment with short SHA & commit message.
* **PR opened / reopened / ready** → 🚀 comment with PR link.
* **PR comment** → 💬 comment quoting the author & first line.
* **PR merged** → ✅ comment then status change to *Developed*.

---

## OpenProject → Discord

Configure an OpenProject *webhook* pointing to `POST http(s)://<server>/op-update` with the sample payload format.

When the server receives a `work_package:updated` event whose `status.id > 8` it posts a Discord message via `DISCORD_WEBHOOK_URL` summarising the change and linking to the work package.

---

Happy automating! 🚀 