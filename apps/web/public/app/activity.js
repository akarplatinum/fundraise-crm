// ---- log ----
function renderLog() {
  const rows = [...CRM.log].reverse().filter((e) => !S.logf || e.type === S.logf);
  document.getElementById("mbody").innerHTML = rows.length
    ? rows
        .map((e) => {
          const m = LOGMETA[e.type] || { i: "•", c: "var(--slate)", v: e.type };
          const who = e.by ? ` <span class="logby">${esc(e.by)}</span>` : "";
          return `<div class="logrow"><div class="logicon" style="background:${m.c}">${m.i}</div><div class="logmain"><div class="lt"><b>${esc(e.firm)}</b> ${m.v}${e.detail ? ` <span style="color:var(--muted)">${esc(e.detail)}</span>` : ""}</div><div class="ld">${fullTime(e.ts)}${who}</div></div><div class="logtime">${relTime(e.ts)}</div></div>`;
        })
        .join("")
    : `<div class="empty">No activity yet.</div>`;
}
const relTime = (ts) => {
  const s = (Date.now() - ts) / 1000;
  return s < 60
    ? "just now"
    : s < 3600
      ? Math.floor(s / 60) + "m ago"
      : s < 86400
        ? Math.floor(s / 3600) + "h ago"
        : Math.floor(s / 86400) + "d ago";
};
const fullTime = (ts) =>
  new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
