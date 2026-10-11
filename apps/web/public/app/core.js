/* ---- motion ---------------------------------------------------------------
   Vendored Motion (window.Motion), used deliberately sparingly. This is a tool
   founders open every day, so motion is spent only where it carries meaning —
   a card changing stage, rows arriving, the drawer entering — and never sits
   between the user and an action. Timings are short enough to read as instant.
   Everything degrades to a no-op under prefers-reduced-motion or if the vendor
   script fails to load, so no interaction depends on an animation finishing. */
const MO = window.Motion || {};
const REDUCE = !MO.animate || matchMedia("(prefers-reduced-motion:reduce)").matches;
const SPRING = { type: "spring", stiffness: 320, damping: 30 };
function fx(el, kf, o) {
  if (REDUCE || !el) return null;
  try {
    return MO.animate(el, kf, o || { duration: 0.18 });
  } catch (_) {
    return null;
  }
}
// Entrance for lists. Capped at 24 nodes: a 200-row directory would otherwise
// spend five seconds staggering, and rows past the fold aren't being watched.
function enterRows(sel, root) {
  if (REDUCE) return;
  [...(root || document).querySelectorAll(sel)]
    .slice(0, 24)
    .forEach((n, i) =>
      fx(
        n,
        { opacity: [0, 1], transform: ["translateY(8px)", "none"] },
        { duration: 0.18, delay: i * 0.024, easing: "ease-out" },
      ),
    );
}
// FLIP. Measure every card, let the caller re-render, then spring each card
// from where it was to where it landed — so advancing a deal reads as the card
// moving across the board rather than the whole board blinking.
function flipCards(render) {
  if (REDUCE) return render();
  const before = new Map();
  document
    .querySelectorAll(".dcard[data-id]")
    .forEach((c) => before.set(c.dataset.id, c.getBoundingClientRect()));
  render();
  document.querySelectorAll(".dcard[data-id]").forEach((c) => {
    const b = before.get(c.dataset.id);
    if (!b)
      return fx(
        c,
        { opacity: [0, 1], transform: ["scale(.97)", "none"] },
        { duration: 0.2, easing: "ease-out" },
      );
    const a = c.getBoundingClientRect(),
      dx = b.left - a.left,
      dy = b.top - a.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    fx(c, { transform: [`translate(${dx}px,${dy}px)`, "none"] }, SPRING);
  });
}
const FLOW = [
  "submitted",
  "intro",
  "meeting_accepted",
  "meeting_booked",
  "followup",
  "diligence",
  "termsheet",
  "signed",
];
const STAGE = {
  submitted: { label: "Submitted", color: "var(--blue)" },
  intro: { label: "Intro sent", color: "var(--amber)" },
  meeting_accepted: { label: "Meeting accepted", color: "var(--cyan)" },
  meeting_booked: { label: "Meeting booked", color: "var(--teal)" },
  followup: { label: "Follow-up", color: "var(--orange)" },
  diligence: { label: "Diligence", color: "var(--violet)" },
  termsheet: { label: "Term sheet", color: "var(--pink)" },
  signed: { label: "Signed", color: "var(--green)" },
  denied: { label: "Denied", color: "var(--red)" },
  past: { label: "Past", color: "var(--slate)" },
};
const BOARDCOLS = [
  "submitted",
  "intro",
  "meeting_accepted",
  "meeting_booked",
  "followup",
  "diligence",
  "termsheet",
  "signed",
  "denied",
  "past",
];
const TERMINAL = ["signed", "denied", "past"];
const isTerm = (s) => TERMINAL.includes(s);
// Where each investor record came from. See data/README.md.
const TIER_LABEL = {
  seed: "curated",
  "fund-list": "fund list",
  researched: "found by research",
  custom: "added by you",
};
const L2S = {};
Object.entries(STAGE).forEach(([k, o]) => (L2S[o.label] = k)); // stage label -> key (for replaying the log)
const LOGMETA = {
  submitted: { i: "↧", c: "var(--blue)", v: "submitted to pipeline" },
  advance: { i: "→", c: "var(--green)", v: "advanced" },
  signed: { i: "✓", c: "var(--green)", v: "signed" },
  committed: { i: "✓", c: "var(--green)", v: "marked committed" },
  denied: { i: "✕", c: "var(--red)", v: "denied" },
  past: { i: "⌁", c: "var(--slate)", v: "moved to past" },
  passed: { i: "✕", c: "var(--red)", v: "passed" },
  reopen: { i: "↺", c: "var(--amber)", v: "reopened" },
  removed: { i: "⌫", c: "var(--slate)", v: "removed from pipeline" },
  intro_warm: { i: "✉", c: "var(--teal)", v: "generated warm intro" },
  intro_cold: { i: "✉", c: "var(--violet)", v: "generated cold email" },
  emailed: { i: "✉", c: "var(--green)", v: "emailed" },
};

let VCS = [],
  AI_READY = false,
  CRM = { deals: {}, log: [] },
  COMPS = [],
  COMPANY = {};
const S = {
  view: "dir",
  q: "",
  type: "",
  pipe: "out",
  tier: "",
  sort: "score",
  dir: "desc",
  cats: new Set(),
  checks: new Set(),
  logf: "",
  page: 1,
  pageSize: 50,
};
const byId = {};
const vc = (id) => byId[id];
let modalCtx = null,
  modalType = "warm",
  drawerId = null;
let sortState = { key: "score", dir: "desc" };

const scoreColor = (s) => (s >= 80 ? "#15764e" : s >= 65 ? "#1fa06a" : s >= 50 ? "#d9a441" : "#c67a52");
const esc = (s) =>
  (s == null ? "" : String(s)).replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[m]);
const deal = (id) => CRM.deals[id];
// check-size buckets (by average check, USD)
const CHECKB = [
  ["ang", "Angel &lt;$100K", 0, 100e3],
  ["s1", "$100K–$500K", 100e3, 500e3],
  ["s2", "$500K–$1M", 500e3, 1e6],
  ["s3", "$1M–$2.5M", 1e6, 2.5e6],
  ["s4", "$2.5M–$5M", 2.5e6, 5e6],
  ["s5", "$5M+", 5e6, Infinity],
];
const checkBucket = (a) => {
  if (a == null) return null;
  const b = CHECKB.find((x) => a >= x[2] && a < x[3]);
  return b ? b[0] : null;
};
const fmtCheck = (n) =>
  n == null
    ? "—"
    : n >= 1e6
      ? "$" + +(n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M"
      : "$" + Math.round(n / 1e3) + "K";
// money formatter that rolls into billions (e.g. $2.14B, $870M, $500K)
// Every figure in the app is formatted through here. The app assumes USD — the
// bundled investor list is US-centric and check sizes are stored as plain
// numbers with no currency attached — so changing currency is this one constant
// plus the locale, not a hunt through the file.
const CUR = "$",
  LOCALE = "en-US";
const money = (n) => {
  n = n || 0;
  const a = Math.abs(n);
  return a >= 1e9
    ? CUR + (n / 1e9).toLocaleString(LOCALE, { maximumFractionDigits: 2 }) + "B"
    : a >= 1e6
      ? CUR + (n / 1e6).toLocaleString(LOCALE, { maximumFractionDigits: a >= 1e8 ? 0 : 2 }) + "M"
      : a >= 1e3
        ? CUR + Math.round(n / 1e3) + "K"
        : CUR + Math.round(n);
};
// Millions, for axis labels and dense table cells where money() is too wide.
const moneyM = (n) => CUR + ((n || 0) / 1e6).toLocaleString(LOCALE, { maximumFractionDigits: 2 }) + "M";
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
// Read from the profile the deck analysis produced ("raising: $3M"), never
// hardcoded — a fixed target is one company's number showing up in everyone
// else's charts. Falls back only when the deck never stated a raise.
const DEFAULT_ROUND_TARGET = 2e6;
function parseRaise(text) {
  const m = String(text || "").match(/\$?\s*([\d.]+)\s*([mkb])/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0) return null;
  return n * { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()];
}
let ROUND_TARGET = DEFAULT_ROUND_TARGET;

// Server stamp from the last read. Echoed back on save so the server can tell a
// real deletion from "this client hadn't seen that deal yet" — without it, one
// person's save would delete deals the other had just added.
let BASE = 0;
let ME = { username: "", display: "" };
// False until /api/crm returns a real board. Saving while false would tell the
// server this client holds nothing, which deletes rows.
let LOADED = false;

async function load() {
  const [d, c, m] = await Promise.all([
    fetch("/api/data").then((r) => r.json()),
    fetch("/api/crm").then((r) => r.json()),
    fetch("/api/me")
      .then((r) => r.json())
      .catch(() => ({})),
  ]);
  VCS = d.vcs || [];
  AI_READY = d.aiReady;
  COMPS = d.competitors || [];
  COMPANY = d.company || {};
  ME = m || ME;
  // A board is only "loaded" if the server actually returned one, and nothing
  // saves until it is. Saving after a failed read would tell the server "I
  // hold no deals", which deletes them. An empty pipeline is indistinguishable from a
  // failed read in the payload, so the distinction has to be made here.
  LOADED = !!(c && c.deals && typeof c.deals === "object" && typeof c._base === "number");
  CRM = LOADED ? c : { deals: {}, log: [], trash: [] };
  BASE = LOADED ? c._base : 0;
  if (!LOADED)
    blockSaving("Could not load your pipeline. Reload before making changes — saving now could erase it.");
  // Multi-tenant: the company name is per-founder, not baked into the page.
  ROUND_TARGET = parseRaise(COMPANY.profile && COMPANY.profile.raising) || DEFAULT_ROUND_TARGET;
  const co = (d.company && d.company.name) || "";
  if (co) document.title = co + " · Fundraise CRM";
  if (!CRM.deals) CRM.deals = {};
  if (!CRM.log) CRM.log = [];
  if (!CRM.trash) CRM.trash = [];
  // Everything the server just handed back is by definition already stored.
  CRM.log.forEach((e) => {
    if (e) e._sent = true;
  });
  VCS.forEach((v) => {
    v.id = v.id || v.firm.toLowerCase().replace(/[^a-z0-9]+/g, "");
    byId[v.id] = v;
  });
  document
    .querySelectorAll("#snav button,#mobnav button")
    .forEach((b) => (b.onclick = () => switchView(b.dataset.v)));
  const sb = document.getElementById("savebtn");
  if (sb) sb.onclick = saveNow;
  if (ME.role === "admin") {
    document.getElementById("setlink").hidden = false;
    document.getElementById("opensettings").onclick = openSettings;
    document.getElementById("set-save").onclick = saveSettings;
    document.getElementById("setbg").onclick = (e) => {
      if (e.target.id === "setbg") closeSettings();
    };
  }
  renderMe();
  switchView("dir");
  loadOutbox().catch(() => {});
  // A run started before the tab was closed is still going; resume watching it
  // rather than leaving the banner frozen on a stale count.
  if ((COMPANY.score || {}).status === "scoring") pollScore();
}
function renderMe() {
  const el = document.getElementById("whoami");
  if (!el) return;
  const name = ME.display || ME.username || "";
  if (!name) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `<span class="who-av">${name.trim().charAt(0).toUpperCase()}</span><span class="who-n">${name}</span><button class="who-out" id="signout" title="Sign out">Sign out</button>`;
  document.getElementById("signout").onclick = async () => {
    await fetch("/api/logout");
    location.href = "/login";
  };
}
// Deals go up in full every time, because the server works out what was deleted
// by comparing what it holds against what this payload keeps — a partial deal
// list would read as "the rest were removed".
//
// The activity log is the opposite: it is append-only and never deleted, it
// grows without limit, and re-sending all of it on every save means a save's
// cost rises forever. Only unsent entries go up. `_sent` is stripped rather
// than uploaded, and entries are marked only after the server confirms.
function payload(confirmBulk) {
  const fresh = CRM.log.filter((e) => e && !e._sent).map(({ _sent, ...e }) => e);
  const body = { ...CRM, log: fresh, _base: BASE };
  if (confirmBulk) body.confirm_bulk = true;
  return JSON.stringify(body);
}
async function push(confirmBulk) {
  // Refusing to save from a board that never loaded is the whole point of
  // LOADED — see load(). Without this, one failed read wipes the pipeline.
  if (!LOADED) throw new Error("pipeline never loaded — reload the page");
  const pending = CRM.log.filter((e) => e && !e._sent);
  const r = await fetch("/api/crm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload(confirmBulk),
  });
  if (r.status === 401) {
    location.href = "/login";
    return null;
  }
  const j = await r.json().catch(() => ({}));
  // The server refuses a save that would delete the board or most of it, because
  // that is what a failed read looks like. A real bulk delete is still possible,
  // but it has to be said out loud — so ask, once, and retry only on a yes.
  // Without this the guard would be a wall rather than a check.
  if (r.status === 409 && j.would_delete && !confirmBulk) {
    if (
      confirm(
        `This save would remove ${j.would_delete} deal(s) from the server.\n\nIf you meant to do that, continue. If the board looked wrong or empty when it loaded, cancel and reload instead.`,
      )
    ) {
      return push(true);
    }
    throw new Error("save cancelled — nothing was changed");
  }
  // Anything but a clean 200 throws, so the screen never shows work the
  // server refused as if it were saved.
  if (!r.ok || j.error) throw new Error(j.error || "save failed (" + r.status + ")");
  // Marked only now: a failed save must leave them queued for the next one.
  pending.forEach((e) => {
    e._sent = true;
  });
  if (j._base) BASE = j._base;
  return j;
}
let st;
function save() {
  clearTimeout(st);
  st = setTimeout(() => {
    push()
      .then((j) => {
        if (j) markSaved();
      })
      .catch((e) => {
        console.error("save failed", e);
        toast("Not saved: " + e.message);
        markUnsaved();
      });
  }, 250);
}
// Keeps the failure on screen after the toast fades: the button stays flagged
// until a save actually lands, so nobody walks away from unsaved work.
function markUnsaved(msg) {
  const b = document.getElementById("savebtn");
  if (b) {
    b.classList.add("unsaved");
    b.textContent = msg || "Unsaved, retry";
  }
}
function markSaved() {
  const b = document.getElementById("savebtn");
  if (b && LOADED) {
    b.classList.remove("unsaved");
    b.textContent = "Save now";
  }
}
// Hard stop, not a warning: used when the board itself is untrustworthy.
function blockSaving(why) {
  const b = document.getElementById("savebtn");
  if (b) {
    b.classList.add("unsaved");
    b.textContent = "Reload, not saving";
    b.title = why;
  }
  toast(why);
}
function logEv(id, type, detail) {
  CRM.log.push({
    id,
    firm: vc(id)?.firm || id,
    type,
    detail: detail || "",
    ts: Date.now(),
    by: ME.username || "",
  });
}

// ---- toast and keyboard ----
let tt;
function toast(m) {
  const t = document.getElementById("toast");
  t.textContent = m;
  t.classList.add("on");
  clearTimeout(tt);
  tt = setTimeout(() => t.classList.remove("on"), 2200);
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeModal();
    closeDrawer();
  }
});
