// Email: files to attach, the outbox, and the API the mailer drains it through.
//
// Two audiences, two kinds of auth:
//
//   handleMail()       the founder in the browser, behind the session cookie.
//   handleMailerApi()  apps/mailer, behind a bearer token generated in the app.
//                      The token resolves to exactly one company, so a mailer
//                      can only ever see and send that company's queue.
//
// Nothing here sends mail. Workers cannot hold an SMTP session to an arbitrary
// mailbox reliably, and a queue means a send attempted while the mailer is
// down waits instead of disappearing.

import { hex, sha256Hex } from "./auth.js";
import { toBase64 } from "./ai.js";
import { badRequest, json, readJson } from "./http.js";
import {
  appendLog,
  cancelEmail,
  deleteFile,
  dueEmails,
  filesById,
  getFileChunk,
  getInvestor,
  getMailer,
  listFiles,
  listOutbox,
  mailerCompany,
  queueEmail,
  recordSendResult,
  retryEmail,
  saveFile,
  setFileDefault,
  setMailerToken,
} from "./store.js";

// 384 KiB of raw bytes per slice: a multiple of three (see schema.sql), and
// small enough that a slice's base64 stays far under D1's 2 MB row limit.
const SLICE_BYTES = 384 * 1024;

// 30 slices plus the bookkeeping statements stays under the 50 queries a Worker
// may issue per request on the Free plan. 11.25 MB is also comfortably under
// Gmail's 25 MB limit once base64 inflates it by a third.
export const MAX_FILE_BYTES = 30 * SLICE_BYTES;

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

export function sliceFile(buf) {
  const slices = [];
  for (let at = 0; at < buf.byteLength; at += SLICE_BYTES) {
    slices.push(toBase64(buf.slice(at, at + SLICE_BYTES)));
  }
  return slices;
}

export async function storeFile(env, companyId, buf, { name, mime, byDefault }, actor) {
  if (!buf.byteLength) throw badRequest("Empty upload.");
  if (buf.byteLength > MAX_FILE_BYTES) {
    throw badRequest(
      `File is too large to email (max ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(1)} MB).`,
      413,
    );
  }
  return saveFile(
    env,
    companyId,
    { name, mime, size: buf.byteLength, slices: sliceFile(buf), byDefault },
    actor,
  );
}

function parseAddresses(raw) {
  const list = String(raw || "")
    .split(/[,;\s]+/)
    .filter(Boolean);
  const bad = list.find((a) => !EMAIL.test(a));
  if (bad) throw badRequest(`"${bad}" is not an email address.`);
  return list;
}

// Founder-facing routes. Returns null for any path it does not own, so the
// router can fall through.
export async function handleMail(request, env, { url, me, companyId }) {
  const p = url.pathname;
  const method = request.method;

  if (p === "/api/files" && method === "GET") {
    return json({ files: await listFiles(env, companyId), maxBytes: MAX_FILE_BYTES });
  }

  // Raw body, like /api/deck: the Worker only needs the bytes.
  if (p === "/api/files" && method === "POST") {
    const name = (url.searchParams.get("name") || "attachment").slice(0, 120);
    const mime = request.headers.get("content-type") || "application/octet-stream";
    const id = await storeFile(
      env,
      companyId,
      await request.arrayBuffer(),
      { name, mime, byDefault: url.searchParams.get("default") === "1" },
      me.username,
    );
    return json({ ok: true, id });
  }

  if (p === "/api/files" && method === "DELETE") {
    await deleteFile(env, companyId, url.searchParams.get("id"));
    return json({ ok: true });
  }

  if (p === "/api/files/default" && method === "POST") {
    const b = await readJson(request);
    await setFileDefault(env, companyId, b.id, !!b.on);
    return json({ ok: true });
  }

  if (p === "/api/outbox" && method === "GET") {
    const [messages, mailer] = await Promise.all([listOutbox(env, companyId), getMailer(env, companyId)]);
    return json({
      messages,
      mailer: mailer ? { configured: true, lastSeen: mailer.last_seen } : { configured: false, lastSeen: 0 },
    });
  }

  if (p === "/api/outbox" && method === "POST") {
    const b = await readJson(request);
    const [to, ...extra] = parseAddresses(b.to);
    if (!to) throw badRequest("Who is this going to? Add an email address.");
    if (extra.length) throw badRequest("Send to one address; put the rest in Cc.");
    const subject = String(b.subject || "").trim();
    const body = String(b.body || "").trim();
    if (!subject) throw badRequest("Add a subject line.");
    if (!body) throw badRequest("The email is empty.");

    const ids = Array.isArray(b.attach) ? b.attach.slice(0, 5) : [];
    const attachments = await filesById(env, companyId, ids);
    if (attachments.length !== ids.length) throw badRequest("One of the attachments no longer exists.");

    const id = await queueEmail(
      env,
      companyId,
      {
        investorId: String(b.investor_id || ""),
        to,
        toName: String(b.to_name || "").slice(0, 120),
        cc: parseAddresses(b.cc).join(", "),
        subject: subject.slice(0, 300),
        body,
        attachments,
        sendAfter: Math.max(0, Number(b.send_after) || 0),
      },
      me.username,
    );
    return json({ ok: true, id });
  }

  if (p === "/api/outbox" && method === "DELETE") {
    await cancelEmail(env, companyId, url.searchParams.get("id"));
    return json({ ok: true });
  }

  if (p === "/api/outbox/retry" && method === "POST") {
    await retryEmail(env, companyId, url.searchParams.get("id"));
    return json({ ok: true });
  }

  // Generating a token replaces the previous one, which is also how you revoke
  // a leaked one. The plain token is returned this once and never stored.
  if (p === "/api/mailer-token" && method === "POST") {
    const token = "mt_" + hex(crypto.getRandomValues(new Uint8Array(24)));
    await setMailerToken(env, companyId, await sha256Hex(token));
    return json({ ok: true, token });
  }

  return null;
}

// Mailer-facing routes, under /api/mailer/. Bearer token only, no session.
export async function handleMailerApi(request, env, url) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const companyId = token ? await mailerCompany(env, await sha256Hex(token)) : null;
  if (!companyId) return json({ error: "bad mailer token" }, 401);

  const p = url.pathname;
  const method = request.method;

  if (p === "/api/mailer/pending" && method === "GET") {
    return json({ pending: await dueEmails(env, companyId) });
  }

  if (p === "/api/mailer/file" && method === "GET") {
    const chunk = await getFileChunk(env, companyId, url.searchParams.get("id"), url.searchParams.get("seq"));
    if (!chunk) return json({ error: "no such file slice" }, 404);
    return json(chunk);
  }

  if (p === "/api/mailer/result" && method === "POST") {
    const b = await readJson(request);
    const row = await recordSendResult(env, companyId, b.id, { ok: !!b.ok, error: b.error });
    // Logged only when the row actually changed, so the activity feed shows
    // each send once even if the mailer reports twice.
    if (row && b.ok && row.investor_id) {
      const inv = await getInvestor(env, companyId, row.investor_id);
      await appendLog(
        env,
        companyId,
        { id: row.investor_id, firm: inv?.firm || "", type: "emailed", detail: `→ ${row.to_email}` },
        "mailer",
      );
    }
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}
