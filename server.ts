/// <reference types="node" />
/// <reference types="bun-types" />
// Bun + TypeScript GitHub → OpenProject helper server
// Usage:
//   bun run server.ts
//
// Environment variables required:
//   PORT                     – Port to listen on (default 3000)
//   GITHUB_WEBHOOK_SECRET    – Shared secret used when configuring GitHub webhooks
//   OPENPROJECT_BASE_URL     – Base URL of your OpenProject instance (e.g. https://openproject.example.com)
//   OPENPROJECT_API_KEY      – API key of the bot/user that will post comments
//   ENFORCE_GITHUB_SIGNATURE – "true" (default) to validate webhook signatures, set to "false" to skip verification

import { createHmac, timingSafeEqual } from "crypto";
import { Buffer } from "buffer";
import { serve } from "bun";
import { createWriteStream } from "fs";
import { once } from "events";

// Helper: verify GitHub signature (HMAC SHA-256)
function verifySignature(rawBody: string | ArrayBuffer, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  const bodyBuf = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
  const hmac = createHmac("sha256", secret);
  hmac.update(bodyBuf);
  const expected = `sha256=${hmac.digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false; // length mismatch
  }
}

// Helper: post a comment to an OpenProject work package
async function postOpenProjectComment(workPackageId: string, comment: string): Promise<void> {
  const baseUrl = process.env.OPENPROJECT_BASE_URL;
  const apiKey = process.env.OPENPROJECT_API_KEY;
  if (!baseUrl || !apiKey) {
    console.error("Missing OPENPROJECT_BASE_URL or OPENPROJECT_API_KEY env vars");
    return;
  }

  const url = `${baseUrl.replace(/\/$/, "")}/api/v3/work_packages/${workPackageId}/activities`;
  // OpenProject expects basic auth with username 'apikey' and the API key as the password
  const auth = Buffer.from(`apikey:${apiKey}`).toString("base64");

  const body = JSON.stringify({ comment: { raw: comment } });

  console.log("➡️  OpenProject POST", url);
  console.log("   Payload:", body);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${auth}`,
      "Accept": "application/json",
    },
    body,
  });

  const respText = await res.text();
  if (res.ok) {
    console.log(`✅ OpenProject response ${res.status}:`, respText);
  } else {
    console.error(`❌ OpenProject API error (${res.status}):`, respText);
  }
}

// Regex to capture work-package ID in branch names.
// Supported patterns:
//   1. op/<id>-...     (e.g., op/12-feature)
//   2. [op-<id>] ...   (legacy)
const OP_TAG_REGEX = /(?:\[op-(\d+)\]|op\/(\d+))/i;

// Should we verify GitHub webhook signatures?
const enforceSignature = (process.env.ENFORCE_GITHUB_SIGNATURE ?? "true").toLowerCase() !== "false";

// --- Logging to file -------------------------------------------------------
const logFilePath = process.env.LOG_FILE ?? "server.log";
const logStream = createWriteStream(logFilePath, { flags: "a" });

function writeToLogFile(...args: any[]) {
  const line = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  logStream.write(`[${new Date().toISOString()}] ${line}\n`);
}

(["log", "warn", "error"] as const).forEach((level) => {
  const original = console[level];
  console[level] = (...args: any[]) => {
    original(...args); // keep printing to stdout/stderr
    writeToLogFile(...args);
  };
});

process.on("SIGINT", () => {
  console.log("Received SIGINT, shutting down.");
  logStream.end();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down.");
  logStream.end();
  process.exit(0);
});
// --- End logging setup ----------------------------------------------------

// Cache of status IDs
let developedStatusId: string | null = null;

async function getDevelopedStatusId(): Promise<string | null> {
  // Manual override via env var
  const manualId = process.env.DEVELOPED_STATUS_ID;
  if (manualId) {
    developedStatusId = manualId;
    return developedStatusId;
  }

  if (developedStatusId) return developedStatusId;
  const baseUrl = process.env.OPENPROJECT_BASE_URL;
  const apiKey = process.env.OPENPROJECT_API_KEY;
  if (!baseUrl || !apiKey) return null;
  const auth = Buffer.from(`apikey:${apiKey}`).toString("base64");
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v3/statuses`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) return null;
  const json: any = await res.json();
  const desiredName = (process.env.DEVELOPED_STATUS_NAME ?? "Developed").toLowerCase();
  const found = (json._embedded?.statuses ?? []).find((s: any) => s.name?.toLowerCase() === desiredName);
  if (found) {
    developedStatusId = String(found.id);
    console.log(`ℹ️  Cached status '${desiredName}' as ID ${developedStatusId}`);
    return developedStatusId;
  }
  console.warn(`⚠️  Status '${desiredName}' not found in OpenProject`);
  return null;
}

// Update work package status to "Developed"
async function setWorkPackageStatusDeveloped(workPackageId: string) {
  const baseUrl = process.env.OPENPROJECT_BASE_URL;
  const apiKey = process.env.OPENPROJECT_API_KEY;
  if (!baseUrl || !apiKey) return;
  const auth = Buffer.from(`apikey:${apiKey}`).toString("base64");

  // Fetch current WP to get lockVersion
  const wpUrl = `${baseUrl.replace(/\/$/, "")}/api/v3/work_packages/${workPackageId}`;
  const wpRes = await fetch(wpUrl, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!wpRes.ok) {
    console.error(`❌ Failed to fetch work package #${workPackageId} (${wpRes.status})`);
    return;
  }
  const wpJson: any = await wpRes.json();
  const lockVersion = wpJson.lockVersion;
  const statusId = await getDevelopedStatusId();
  if (!statusId) return;

  const patchBody = {
    lockVersion,
    _links: { status: { href: `/api/v3/statuses/${statusId}` } },
  };

  console.log(`🔄 Setting status of WP #${workPackageId} to Developed (ID ${statusId})`);
  const patchRes = await fetch(wpUrl, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify(patchBody),
  });
  const respText = await patchRes.text();
  if (patchRes.ok) {
    console.log(`✅ Work package #${workPackageId} status updated.`, respText);
  } else {
    console.error(`❌ Failed to update status (${patchRes.status}):`, respText);
  }
}

function extractWpIdFromString(text: string): string | null {
  const m = text.match(OP_TAG_REGEX);
  if (!m) return null;
  return m[1] || m[2] || null;
}

serve({
  port: Number(process.env.PORT ?? 3000),
  async fetch(req) {
    const { pathname } = new URL(req.url);

    // Health-check endpoint ➜ always 200 OK JSON
    if (req.method === "GET" && pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Only handle GitHub webhooks below
    if (req.method !== "POST") {
      return new Response("Not Found", { status: 404 });
    }

    const signature = req.headers.get("x-hub-signature-256");
    const secret = process.env.GITHUB_WEBHOOK_SECRET ?? "";

    // GitHub will send JSON; we need raw body for signature verification
    const rawBody = await req.text();

    console.log("🔔 Incoming request", {
      ip: req.headers.get("x-forwarded-for") ?? "unknown",
      event: req.headers.get("x-github-event"),
      delivery: req.headers.get("x-github-delivery"),
    });

    if (enforceSignature) {
      if (!verifySignature(rawBody, signature, secret)) {
        console.warn("⚠️  Signature verification failed");
        return new Response("Invalid signature", { status: 401 });
      }
    } else {
      console.warn("⚠️  Signature verification is DISABLED (ENFORCE_GITHUB_SIGNATURE=false)");
    }

    // Now safe to parse JSON
    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      console.error("❌ Could not parse JSON payload");
      return new Response("Bad JSON", { status: 400 });
    }

    const event = req.headers.get("x-github-event");

    // Branch creation events
    if (event === "create" && payload.ref_type === "branch") {
      const branchName: string = payload.ref;
      const match = branchName.match(OP_TAG_REGEX);
      if (match) {
        const workPackageId = match[1] || match[2];
        const repoName: string = payload.repository?.full_name ?? "unknown repo";
        const branchUrl = `https://github.com/${repoName}/tree/${encodeURIComponent(branchName)}`;
        const comment = `🔀 Branch [\`${branchName}\`](${branchUrl}) created in GitHub repository **${repoName}**.`;
        console.log(`📝 Posting comment to OpenProject work package #${workPackageId}`);
        await postOpenProjectComment(workPackageId, comment);
        console.log("✅ Comment posted");
      }
    }

    // Push events: one or more commits pushed to a branch
    if (event === "push") {
      const fullRef: string = payload.ref; // e.g., refs/heads/op/12-feature
      const branchName = fullRef.replace(/^refs\/heads\//, "");
      const match = branchName.match(OP_TAG_REGEX);
      if (match) {
        const workPackageId = match[1] || match[2];
        const repoName: string = payload.repository?.full_name ?? "unknown repo";

        const commits: any[] = payload.commits ?? [];
        for (const c of commits) {
          const sha: string = c.id;
          const shortSha = sha.substring(0, 7);
          const commitUrl = `https://github.com/${repoName}/commit/${sha}`;
          const msg = c.message.split("\n")[0];
          const comment = `📦 Commit [\`${shortSha}\`](${commitUrl}) pushed to branch \`${branchName}\`: ${msg}`;
          console.log(`📝 Posting commit comment (${shortSha}) to work package #${workPackageId}`);
          await postOpenProjectComment(workPackageId, comment);
        }
        if (commits.length) console.log("✅ Commit comments posted");
      }
    }

    // Pull request closed (merged) -> update status
    if (event === "pull_request" && payload.action === "closed" && payload.pull_request?.merged) {
      const branchName: string = payload.pull_request.head.ref;
      let workPackageId = extractWpIdFromString(branchName);
      if (!workPackageId) {
        workPackageId = extractWpIdFromString(payload.pull_request.title ?? "");
      }
      if (workPackageId) {
        const prNumber: number = payload.number;
        const prTitle: string = payload.pull_request.title ?? "Pull Request";
        const prUrl: string = payload.pull_request.html_url;

        const mergeComment = `✅ Pull request [#${prNumber}: ${prTitle}](${prUrl}) merged into **${payload.repository?.full_name ?? "repo"}**.`;
        console.log(`📝 Posting merge comment (#${prNumber}) to work package #${workPackageId}`);
        await postOpenProjectComment(workPackageId, mergeComment);

        console.log(`🔧 Updating WP #${workPackageId} status to Developed`);
        await setWorkPackageStatusDeveloped(workPackageId);
      }
    }

    // Pull request opened -> leave a comment
    if (event === "pull_request" && ["opened", "reopened", "ready_for_review"].includes(payload.action)) {
      const branchName: string = payload.pull_request.head.ref;
      let workPackageId = extractWpIdFromString(branchName);
      if (!workPackageId) {
        workPackageId = extractWpIdFromString(payload.pull_request.title ?? "");
      }
      if (workPackageId) {
        const repoName: string = payload.repository?.full_name ?? "unknown repo";
        const prNumber: number = payload.number;
        const prTitle: string = payload.pull_request.title ?? "Pull Request";
        const prUrl: string = payload.pull_request.html_url;
        const comment = `🚀 Pull request [#${prNumber}: ${prTitle}](${prUrl}) opened targeting branch \`${branchName}\` in **${repoName}**.`;
        console.log(`📝 Posting PR comment (#${prNumber}) to work package #${workPackageId}`);
        await postOpenProjectComment(workPackageId, comment);
      }
    }

    // New comment on PR -> propagate to WP
    if (event === "issue_comment" && payload.action === "created" && payload.issue?.pull_request) {
      const prTitle: string = payload.issue.title ?? "";
      const workPackageId = extractWpIdFromString(prTitle);
      if (workPackageId) {
        const repoName: string = payload.repository?.full_name ?? "repo";
        const prNumber: number = payload.issue.number;
        const commentUser: string = payload.comment?.user?.login ?? "someone";
        const commentBody: string = (payload.comment?.body ?? "").split("\n")[0];
        const commentUrl: string = payload.comment?.html_url;
        const wpComment = `💬 Comment by **@${commentUser}** on PR [#${prNumber}](${commentUrl}) in **${repoName}**: ${commentBody}`;
        console.log(`📝 Posting PR comment from ${commentUser} to WP #${workPackageId}`);
        await postOpenProjectComment(workPackageId, wpComment);
      }
    }

    // Respond quickly to GitHub (must be <10s)
    return new Response("OK", { status: 200 });
  },
});

const effectivePort = Number(process.env.PORT ?? 3000);
console.log(`🚀 Pikachu helper listening on port ${effectivePort}`);
