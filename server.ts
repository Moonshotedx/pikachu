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
// Cache of the default task type id
let taskTypeId: string | null = null;

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

async function getTaskTypeId(): Promise<string | null> {
  // Allow overriding via env
  const envId = process.env.TASK_TYPE_ID;
  if (envId) {
    taskTypeId = envId;
    return taskTypeId;
  }

  if (taskTypeId) return taskTypeId;

  const baseUrl = process.env.OPENPROJECT_BASE_URL;
  const apiKey = process.env.OPENPROJECT_API_KEY;
  if (!baseUrl || !apiKey) return null;

  const auth = Buffer.from(`apikey:${apiKey}`).toString("base64");
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v3/types`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) return null;
  const json: any = await res.json();
  const task = (json._embedded?.elements ?? []).find((t: any) => (t.name ?? "").toLowerCase() === "task");
  if (task) {
    taskTypeId = String(task.id);
    console.log(`ℹ️  Cached 'Task' type as ID ${taskTypeId}`);
    return taskTypeId;
  }
  console.warn("⚠️  Could not resolve Task type id from OpenProject");
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

// Discord notification helper ------------------------------------------------
async function sendDiscordNotification(message: string, webhookUrl?: string) {
  const url = webhookUrl || process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.warn("DISCORD_WEBHOOK_URL not set; skipping Discord notification");
    return;
  }

  // Discord messages cannot exceed 2000 characters. We'll send in chunks ≤1900.
  const MAX_LEN = 1900;
  const chunks: string[] = [];
  let remaining = message;
  while (remaining.length > MAX_LEN) {
    let splitIdx = remaining.lastIndexOf("\n", MAX_LEN);
    if (splitIdx === -1 || splitIdx < 1500) {
      // No newline found in a reasonable window, hard split
      splitIdx = MAX_LEN;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  if (remaining.length) chunks.push(remaining);

  for (const chunk of chunks) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: chunk }),
      });
      if (!res.ok) {
        console.error(`❌ Discord webhook error ${res.status}`);
      }
    } catch (e) {
      console.error("❌ Discord webhook exception", e);
    }
  }
}

// ---- Helper to query OpenProject work packages with arbitrary filters ------
async function fetchWorkPackages(filters: any[]): Promise<any[]> {
  const baseUrl = process.env.OPENPROJECT_BASE_URL;
  const apiKey = process.env.OPENPROJECT_API_KEY;
  if (!baseUrl || !apiKey) {
    console.error("Missing OPENPROJECT_BASE_URL or OPENPROJECT_API_KEY env vars");
    return [];
  }
  const auth = Buffer.from(`apikey:${apiKey}`).toString("base64");
  const query = encodeURIComponent(JSON.stringify(filters));
  const url = `${baseUrl.replace(/\/$/, "")}/api/v3/work_packages?filters=${query}&pageSize=500&include=status,assignee,project`;
  console.log("➡️  OpenProject GET", url);
  const res = await fetch(url, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    console.error(`❌ OpenProject API error (${res.status}) when querying work packages`);
    return [];
  }
  const json: any = await res.json();
  return json._embedded?.elements ?? [];
}

function mapWpSummary(wp: any) {
  return {
    id: wp.id,
    subject: wp.subject,
    status:
      wp._embedded?.status?.name ??
      wp.status?.name ??
      wp._links?.status?.title ??
      "unknown",
    assignee:
      wp._embedded?.assignee?.name ??
      wp.assignee?.name ??
      wp._links?.assignee?.title ??
      null,
    project:
      wp._embedded?.project?.name ??
      wp._embedded?.project?.title ??
      wp.project?.name ??
      wp._links?.project?.title ??
      null,
    startDate: wp.startDate ?? wp.start_date ?? null,
    dueDate: wp.dueDate,
  };
}

// NEW: Reusable function that returns today's and overdue task summaries
export async function getTodaySummary(): Promise<{ today: any[]; overdue: any[] }> {
  const taskId = await getTaskTypeId();

  // Tasks due today
  const dueTodayFilters = [
    { due_date: { operator: "t", values: [] } }, // today
    ...(taskId ? [{ type: { operator: "=", values: [taskId] } }] : []),
  ];

  // Overdue tasks (due date before today)
  const overdueFilters = [
    { due_date: { operator: "<t-", values: ["0"] } }, // before today
    ...(taskId ? [{ type: { operator: "=", values: [taskId] } }] : []),
  ];

  const [todayWps, overdueWps] = await Promise.all([
    fetchWorkPackages(dueTodayFilters),
    fetchWorkPackages(overdueFilters),
  ]);

  // Filter helper – consider a work-package open if status.isClosed !== true
  const isOpen = (wp: any): boolean => {
    const embeddedStatus = wp._embedded?.status;

    // 1. Prefer explicit boolean flag if available
    if (embeddedStatus && typeof embeddedStatus.isClosed === "boolean") {
      return !embeddedStatus.isClosed;
    }

    // 2. Check embedded status name
    if (embeddedStatus?.name) {
      return embeddedStatus.name.toString().toLowerCase() !== "closed";
    }

    // 3. Fallback to _links.status.title (often present when not embedded)
    const linkStatusTitle = wp._links?.status?.title;
    if (linkStatusTitle) {
      return linkStatusTitle.toString().toLowerCase() !== "closed";
    }

    // 4. Finally, inspect status id from href (e.g., /api/v3/statuses/11)
    const href: string | undefined = wp._links?.status?.href;
    if (href) {
      const idStr = href.split("/").pop();
      const idNum = Number(idStr);
      if (!Number.isNaN(idNum)) {
        // Convention in this project: status id > 8 considered closed/completed
        return idNum <= 8;
      }
    }

    // If in doubt, treat as open (so we don't accidentally hide tasks)
    return true;
  };

  return {
    today: todayWps.filter(isOpen).map(mapWpSummary),
    overdue: overdueWps.filter(isOpen).map(mapWpSummary),
  };
}

// Helper: build markdown table for Discord messages
function buildMarkdownTable(
  headers: string[],
  rows: (string | number | null)[][],
  fixedWidths?: number[],
): string {
  if (!rows.length) return "_No tasks_";
  const allRows = [headers, ...rows];
  const colWidths = headers.map((_, idx) => {
    const computed = Math.max(...allRows.map((r) => String(r[idx] ?? "").length));
    return fixedWidths && fixedWidths[idx] ? Math.max(fixedWidths[idx], computed) : computed;
  });
  const pad = (val: string, len: number) => val + " ".repeat(len - val.length);
  const formatRow = (row: any[]) =>
    "|" + row.map((cell, idx) => pad(String(cell ?? ""), colWidths[idx])).join("|") + "|";
  const lines = [
    formatRow(headers),
    "|" + colWidths.map((w) => "-".repeat(w)).join("|") + "|",
    ...rows.map(formatRow),
  ];
  return lines.join("\n");
}

// Format the daily summary into a Discord-friendly markdown message
async function formatDailySummaryMessage(): Promise<string> {
  const summary = await getTodaySummary();
  const todayStr = new Date().toISOString().slice(0, 10);

  function truncate(str: string, max = 30) {
    return str.length > max ? str.slice(0, max - 3) + "..." : str;
  }

  const formatItem = (wp: any, includeDue = false) => {
    const parts = [
      `**#${wp.id}**`,
      truncate(wp.subject, 40),
      `(${wp.status})`,
      wp.assignee ? `— ${wp.assignee}` : "",
      includeDue && wp.dueDate ? `— Due ${wp.dueDate}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return `• ${parts}`;
  };

  const todayList = summary.today.map((wp) => formatItem(wp)).join("\n");
  const overdueList = summary.overdue
    .map((wp) => formatItem(wp, true))
    .join("\n");

  return [
    `📋 **Daily Task Summary (${todayStr})**`,
    "",
    "**Due Today:**",
    todayList || "No tasks due today.",
    "",
    "**Overdue Tasks:**",
    overdueList || "No overdue tasks.",
  ].join("\n");
}

// Scheduler: run at configured times each day to send the summary to Discord
function scheduleDailySummaries() {
  const timesEnv = process.env.DAILY_SUMMARY_TIMES; // e.g., "12:00,16:00,20:30"
  if (!timesEnv) {
    console.log("ℹ️  DAILY_SUMMARY_TIMES not set; daily summaries disabled");
    return;
  }

  const times = timesEnv.split(/[,;\s]+/).filter(Boolean);
  if (!times.length) return;

  function scheduleForTime(timeStr: string) {
    const [hStr, mStr = "0"] = timeStr.split(":");
    const hour = Number(hStr);
    const minute = Number(mStr);
    if (isNaN(hour) || hour < 0 || hour > 23 || isNaN(minute) || minute < 0 || minute > 59) {
      console.warn(`⚠️  Invalid DAILY_SUMMARY_TIMES entry '${timeStr}', skipping`);
      return;
    }

    const scheduleNext = () => {
      const now = new Date();
      const next = new Date(now);
      next.setHours(hour, minute, 0, 0);
      if (next <= now) {
        next.setDate(now.getDate() + 1);
      }
      const delay = next.getTime() - now.getTime();
      console.log(`⏰ Scheduled daily summary for ${timeStr} in ${Math.round(delay / 1000)}s`);
      setTimeout(async () => {
        try {
          const content = await formatDailySummaryMessage();
          await sendDiscordNotification(content, process.env.DISCORD_SUMMARY_WEBHOOK_URL || undefined);
          console.log("✅ Daily summary sent to Discord (" + timeStr + ")");
        } catch (e) {
          console.error("❌ Failed to send daily summary", e);
        }
        scheduleNext(); // reschedule for next day
      }, delay);
    };

    scheduleNext();
  }

  times.forEach(scheduleForTime);
}

// --------------------------------------------------------------------------

serve({
  port: Number(process.env.PORT ?? 3000),
  async fetch(req) {
    const { pathname } = new URL(req.url);
    console.log(`🌐 ${req.method} ${pathname}`);

    // Health-check endpoint ➜ always 200 OK JSON
    if (req.method === "GET" && pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Summary of today's and overdue tasks
    if (req.method === "GET" && pathname === "/getTodaySummary") {
      const summary = await getTodaySummary();
      return new Response(JSON.stringify(summary), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Trigger daily summary to Discord immediately
    if (req.method === "GET" && pathname === "/triggerNow") {
      try {
        const msg = await formatDailySummaryMessage();
        await sendDiscordNotification(msg, process.env.DISCORD_SUMMARY_WEBHOOK_URL || undefined);
        return new Response(JSON.stringify({ status: "sent" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        console.error("❌ Failed to send on-demand summary", e);
        return new Response("Error", { status: 500 });
      }
    }

    // OpenProject webhook endpoint — handle before reading body elsewhere
    if (req.method === "POST" && pathname === "/op-update") {
      const bodyText = await req.text();
      let payload: any;
      try {
        payload = JSON.parse(bodyText);
      } catch {
        return new Response("Bad JSON", { status: 400 });
      }

      if (payload.action === "work_package:updated") {
        const statusObj = payload.work_package?.status ?? payload.work_package?._embedded?.status ?? {};
        const statusIdRaw = statusObj.id;
        const statusId = Number(statusIdRaw);
        const statusName = statusObj.name ?? `Status ${statusId}`;
        console.log("raw", statusIdRaw);
        console.log("id:", statusId);
        console.log("type:", typeof statusId);
        console.log(typeof statusId === "number" && statusId > 8);
        if (typeof statusId === "number" && statusId > 8) {
          console.log("🔔 Sending Discord notification for WP update now");
          const wpId = payload.work_package?.id;
          const subject = payload.work_package?.subject ?? "WP";
          const project = payload.work_package?._embedded?.project?.identifier ?? "project";
          const base = process.env.OPENPROJECT_BASE_URL ?? "";
          const wpUrl = `${base}/work_packages/${wpId}`;
          const msg = `🛠️ Work package **#${wpId} - ${subject}** in project **${project}** moved to **${statusName}**.\n${wpUrl}`;
          console.log("📨 Sending Discord message:", msg);
          await sendDiscordNotification(msg);
        }
      } else if (payload.action === "work_package:created") {
        // New work package created → notify Discord (if webhook configured)
        const wpId = payload.work_package?.id;
        const subject = payload.work_package?.subject ?? "Work package";
        const project = payload.work_package?._embedded?.project?.identifier ?? "project";
        const author = payload.work_package?._embedded?.author?.name ?? "someone";
        const base = process.env.OPENPROJECT_BASE_URL ?? "";
        const wpUrl = `${base}/work_packages/${wpId}`;
        const msg = `🆕 Work package **#${wpId} - ${subject}** created in project **${project}** by **${author}**.\n${wpUrl}`;
        console.log("🔔 Sending Discord notification for WP creation now");
        console.log("📨 Sending Discord message:", msg);
        await sendDiscordNotification(msg);
      }

      return new Response("OK", { status: 200 });
    }

    // ---- GitHub webhook handling below (may read body for signature) ----
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

// Kick off daily summary scheduler after server start
scheduleDailySummaries();
