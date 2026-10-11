#!/usr/bin/env node
// Drains the CRM's outbox through your own mailbox.
//
// The CRM queues emails; this sends them over SMTP from your address, so
// replies come back to your inbox and thread normally. It is one short run,
// not a server: schedule it every few minutes with GitHub Actions (see
// .github/workflows/mailer.yml) or cron, and each run sends whatever is due.
//
// Environment (see docs/email.md for per-provider values):
//   CRM_URL      your deployed app, e.g. https://my-crm.pages.dev
//   CRM_TOKEN    the mailer token from the app's Outbox page
//   SMTP_HOST    e.g. smtp.gmail.com
//   SMTP_PORT    465 (TLS) or 587 (STARTTLS); default 465
//   SMTP_USER    the address you send from
//   SMTP_PASS    an app password for that mailbox, not your login password
//   MAIL_FROM_NAME  the name recipients see; default is the address alone
//
// Usage:
//   node mailer.js            send everything that is due
//   node mailer.js --dry-run  print what would be sent, change nothing
//   node mailer.js --check    log in to SMTP and to the CRM, send nothing

const { sendMail } = require("./smtp.js");

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const CHECK = args.has("--check");

function settings() {
  const env = process.env;
  // A dry run only reads the queue, so it does not need mailbox credentials.
  const required = ["CRM_URL", "CRM_TOKEN", ...(DRY_RUN ? [] : ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"])];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing ${missing.join(", ")}. See docs/email.md.`);
  return {
    crmUrl: String(env.CRM_URL || "").replace(/\/$/, ""),
    crmToken: env.CRM_TOKEN,
    smtp: {
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT || 465),
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      fromName: env.MAIL_FROM_NAME || "",
    },
  };
}

function crmClient({ crmUrl, crmToken }) {
  return async function crm(route, body) {
    const res = await fetch(crmUrl + route, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${crmToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${route}: ${data.error || `HTTP ${res.status}`}`);
    return data;
  };
}

// An attachment's base64, fetched one stored slice at a time.
async function* fileChunks(crm, fileId) {
  for (let seq = 0, total = 1; seq < total; seq++) {
    const slice = await crm(`/api/mailer/file?id=${fileId}&seq=${seq}`);
    total = slice.chunks;
    yield slice.data;
  }
}

async function main() {
  const config = settings();
  const crm = crmClient(config);

  if (CHECK) {
    await sendMail(config.smtp, null);
    console.log(`SMTP login ok: ${config.smtp.user} via ${config.smtp.host}:${config.smtp.port}`);
    const { pending } = await crm("/api/mailer/pending");
    console.log(`CRM ok: ${pending.length} message(s) due`);
    return;
  }

  const { pending } = await crm("/api/mailer/pending");
  if (!pending.length) return console.log("Nothing to send.");

  let failures = 0;
  for (const msg of pending) {
    const files = msg.attachments.map((f) => f.name).join(", ");
    const label = `#${msg.id} to ${msg.to_email}${files ? ` with ${files}` : ""}`;
    if (DRY_RUN) {
      console.log(`--- would send ${label}\nSubject: ${msg.subject}\n\n${msg.body}\n`);
      continue;
    }
    try {
      await sendMail(config.smtp, {
        to: msg.to_email,
        toName: msg.to_name,
        cc: msg.cc,
        subject: msg.subject,
        body: msg.body,
        attachments: msg.attachments.map((f) => ({ ...f, chunks: fileChunks(crm, f.id) })),
      });
      await crm("/api/mailer/result", { id: msg.id, ok: true });
      console.log(`sent ${label}`);
    } catch (e) {
      // Recorded on the message so the failure shows in the app, where it can
      // be retried, rather than only in this run's log.
      failures++;
      await crm("/api/mailer/result", { id: msg.id, ok: false, error: e.message });
      console.error(`failed ${label}: ${e.message}`);
    }
  }
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
