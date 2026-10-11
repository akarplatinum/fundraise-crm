// ---- email ----
//
// The app queues; apps/mailer sends from the founder's own mailbox. So
// "Queue to send" is honest about what happens: the message goes out the
// next time the mailer runs, and the Outbox shows when it did.
const OUTBOX = { messages: [], mailer: { configured: false, lastSeen: 0 }, files: [], maxBytes: 0 };

async function loadOutbox() {
  const [o, f] = await Promise.all([
    fetch("/api/outbox").then((r) => r.json()),
    fetch("/api/files").then((r) => r.json()),
  ]);
  OUTBOX.messages = o.messages || [];
  OUTBOX.mailer = o.mailer || OUTBOX.mailer;
  OUTBOX.files = f.files || [];
  OUTBOX.maxBytes = f.maxBytes || 0;
  const ct = document.getElementById("ct-outbox");
  if (ct) ct.textContent = OUTBOX.messages.filter((m) => !m.sent_at && !m.failed_at).length;
}

function mailStatus(m) {
  if (m.sent_at) return ["sent", "Sent " + new Date(m.sent_at).toLocaleString()];
  if (m.failed_at) return ["failed", "Failed: " + m.error];
  return [
    "queued",
    m.send_after > Date.now() ? "Scheduled " + new Date(m.send_after).toLocaleString() : "Queued",
  ];
}

function mailerSummary() {
  const { configured, lastSeen } = OUTBOX.mailer;
  if (!configured) return "No mailer is connected yet, so queued email will wait.";
  if (!lastSeen) return "Mailer token created; the mailer has not checked in yet.";
  return "Mailer last checked in " + new Date(lastSeen).toLocaleString() + ".";
}

// Cold drafts start with "Subject: …". Split it off so it lands in the
// subject field rather than the first line of the email.
function splitSubject(text) {
  const m = text.match(/^\s*subject:\s*(.+)\r?\n+/i);
  return m
    ? { subject: m[1].trim(), body: text.slice(m[0].length).trim() }
    : { subject: "", body: text.trim() };
}

async function openSend() {
  const v = modalCtx;
  const p = v.best_partner || {};
  const { subject, body } = splitSubject(document.getElementById("m-out").textContent);
  // A warm request goes to the mutual connection, whose address we do
  // not know; only a cold email defaults to the partner.
  document.getElementById("m-to").value = modalType === "cold" ? p.email || "" : "";
  document.getElementById("m-subject").value = subject || (COMPANY.name ? COMPANY.name + " / " + v.firm : "");
  document.getElementById("m-body").value = body;
  document.getElementById("m-send").hidden = false;
  await loadOutbox();
  document.getElementById("m-files").innerHTML = OUTBOX.files.length
    ? OUTBOX.files
        .map(
          (f) =>
            `<label class="attachrow"><input type="checkbox" data-attach="${f.id}" ${f.attach_by_default ? "checked" : ""}> Attach ${esc(f.name)} (${(f.size / 1e6).toFixed(1)} MB)</label>`,
        )
        .join("")
    : `<div class="sethint">No files to attach. Add your deck in the Outbox.</div>`;
  document.getElementById("m-mailer").textContent = mailerSummary();
  document.getElementById(modalType === "cold" && p.email ? "m-subject" : "m-to").focus();
}

async function queueSend() {
  const v = modalCtx;
  const btn = document.getElementById("m-queue");
  btn.disabled = true;
  try {
    const r = await fetch("/api/outbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        investor_id: v.id,
        to: document.getElementById("m-to").value,
        to_name: modalType === "cold" ? (v.best_partner || {}).name || "" : "",
        subject: document.getElementById("m-subject").value,
        body: document.getElementById("m-body").value,
        attach: [...document.querySelectorAll("#m-files [data-attach]:checked")].map((x) =>
          Number(x.dataset.attach),
        ),
      }),
    });
    const j = await r.json();
    if (!r.ok) return toast(j.error || "Could not queue that email.");
    toast("Queued. It goes out the next time the mailer runs.");
    closeModal();
    await loadOutbox();
    if (S.view === "outbox") renderOutbox();
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("m-email").onclick = openSend;
document.getElementById("m-queue").onclick = queueSend;

async function uploadFile(file) {
  if (file.size > OUTBOX.maxBytes) {
    return toast(`${file.name} is over ${(OUTBOX.maxBytes / 1e6).toFixed(1)} MB, too big to email.`);
  }
  const isFirst = !OUTBOX.files.length;
  const r = await fetch(`/api/files?name=${encodeURIComponent(file.name)}${isFirst ? "&default=1" : ""}`, {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  const j = await r.json();
  if (!r.ok) return toast(j.error || "Upload failed.");
  toast(file.name + " uploaded");
  await loadOutbox();
  renderOutbox();
}

async function outboxAction(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) toast(j.error || "That did not work.");
  await loadOutbox();
  renderOutbox();
  return j;
}

async function newMailerToken() {
  if (OUTBOX.mailer.configured && !confirm("Replace the current mailer token? The old one stops working."))
    return;
  const { token } = await outboxAction("POST", "/api/mailer-token");
  if (!token) return;
  const box = document.getElementById("tokenbox");
  box.hidden = false;
  box.querySelector("pre").textContent = `CRM_URL=${location.origin}\nCRM_TOKEN=${token}`;
}

function renderOutbox() {
  const mb = document.getElementById("mbody");
  const files = OUTBOX.files
    .map(
      (f) => `<tr>
        <td class="fcell"><b>${esc(f.name)}</b><div class="fx">${(f.size / 1e6).toFixed(1)} MB</div></td>
        <td><label class="attachrow"><input type="checkbox" data-default="${f.id}" ${f.attach_by_default ? "checked" : ""}> Attach to every email</label></td>
        <td><button class="ghost sm" data-delfile="${f.id}">Delete</button></td>
      </tr>`,
    )
    .join("");
  const messages = OUTBOX.messages
    .map((m) => {
      const [cls, label] = mailStatus(m);
      const files = m.attachments.map((f) => esc(f.name)).join(", ");
      return `<tr>
        <td><span class="mailstatus ${cls}">${esc(label)}</span></td>
        <td class="fcell"><b>${esc(m.subject)}</b><div class="fx">to ${esc(m.to_email)}${m.cc ? ", cc " + esc(m.cc) : ""}${files ? " · " + files : ""}</div></td>
        <td style="white-space:nowrap">${
          m.sent_at
            ? ""
            : (m.failed_at ? `<button class="ghost sm" data-retry="${m.id}">Retry</button> ` : "") +
              `<button class="ghost sm" data-cancel="${m.id}">Cancel</button>`
        }</td>
      </tr>`;
    })
    .join("");

  mb.innerHTML = `
    <div class="outbox-setup">
      <b>Sending from your mailbox.</b> ${esc(mailerSummary())}
      The mailer is a small script in this repo (<code>apps/mailer</code>) that runs on a schedule, usually as a
      GitHub Action in your fork. It needs the two values below plus your SMTP login.
      Setup steps for Gmail, Outlook and others are in <code>docs/email.md</code>.
      <div class="pill-row" style="margin-top:10px">
        <button class="btn sm" id="newtoken">${OUTBOX.mailer.configured ? "Replace mailer token" : "Create mailer token"}</button>
      </div>
      <div id="tokenbox" hidden>
        <p class="sethint">Copy these into your mailer's secrets now. The token is not shown again.</p>
        <pre></pre>
      </div>
    </div>
    <div class="counted">Attachments
      <label class="btn sm" style="margin-left:10px">Upload a file<input type="file" id="fileup" hidden></label>
    </div>
    ${files ? `<div class="tablewrap"><table><tbody>${files}</tbody></table></div>` : `<div class="empty">No files yet. The deck you upload during onboarding lands here automatically.</div>`}
    <div class="counted" style="margin-top:18px">${OUTBOX.messages.length} message${OUTBOX.messages.length === 1 ? "" : "s"}</div>
    ${messages ? `<div class="tablewrap"><table><tbody>${messages}</tbody></table></div>` : `<div class="empty">Nothing queued. Generate an intro from any investor and choose "Email it".</div>`}`;

  mb.querySelector("#newtoken").onclick = newMailerToken;
  mb.querySelector("#fileup").onchange = (e) => e.target.files[0] && uploadFile(e.target.files[0]);
  mb.querySelectorAll("[data-default]").forEach(
    (x) =>
      (x.onchange = () =>
        outboxAction("POST", "/api/files/default", { id: Number(x.dataset.default), on: x.checked })),
  );
  mb.querySelectorAll("[data-delfile]").forEach(
    (x) =>
      (x.onclick = () =>
        confirm("Delete this file?") && outboxAction("DELETE", "/api/files?id=" + x.dataset.delfile)),
  );
  mb.querySelectorAll("[data-retry]").forEach(
    (x) => (x.onclick = () => outboxAction("POST", "/api/outbox/retry?id=" + x.dataset.retry)),
  );
  mb.querySelectorAll("[data-cancel]").forEach(
    (x) =>
      (x.onclick = () =>
        confirm("Cancel this email?") && outboxAction("DELETE", "/api/outbox?id=" + x.dataset.cancel)),
  );
}
