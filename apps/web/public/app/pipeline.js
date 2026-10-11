// ---- pipeline ----
const counts = () => {
  const c = {};
  BOARDCOLS.forEach((s) => (c[s] = 0));
  Object.values(CRM.deals).forEach((d) => {
    if (!d._noteonly && c[d.stage] != null) c[d.stage]++;
  });
  return c;
};
// parse a user-entered deal value ("$500K","2.5M","500,000") → USD
function num$(s) {
  if (typeof s === "number") return s;
  if (!s) return 0;
  const t = String(s).toLowerCase().replace(/[,$ ]/g, "");
  const m = t.match(/(\d+(?:\.\d+)?)\s*([km])?/);
  if (!m) return 0;
  let v = parseFloat(m[1]);
  if (isNaN(v)) return 0;
  if (m[2] === "k") v *= 1e3;
  else if (m[2] === "m") v *= 1e6;
  else if (v < 100) v *= 1e6;
  return v;
}
function capitalFlow() {
  const g = { pending: 0, termsheet: 0, committed: 0, lost: 0 },
    n = { pending: 0, termsheet: 0, committed: 0, lost: 0 };
  Object.entries(CRM.deals).forEach(([id, d]) => {
    if (d._noteonly) return;
    const v = vc(id);
    if (!v) return;
    const cap = d.value ? num$(d.value) : v.check_avg || 0;
    const k =
      d.stage === "signed"
        ? "committed"
        : d.stage === "diligence" || d.stage === "termsheet"
          ? "termsheet"
          : d.stage === "denied" || d.stage === "past"
            ? "lost"
            : "pending";
    g[k] += cap;
    n[k]++;
  });
  return { g, n };
}
function renderCapital() {
  const { g, n } = capitalFlow();
  const active = g.pending + g.termsheet + g.committed;
  const scale = Math.max(ROUND_TARGET, active) || ROUND_TARGET;
  const f = moneyM;
  const seg = (val, color, label) =>
    val > 0
      ? `<div class="seg" style="flex:${val} 1 0;background:${color}" title="${label}: ${f(val)}">${val / scale > 0.1 ? f(val) : ""}</div>`
      : "";
  const priced = VCS.filter((v) => v.check_avg != null);
  const totMin = priced.reduce((t, v) => t + (v.check_min || 0), 0),
    totMax = priced.reduce((t, v) => t + (v.check_max || 0), 0);
  const gap = Math.max(0, scale - active);
  const bar = `<div class="capbar">${seg(g.committed, "var(--green)", "Committed")}${seg(g.termsheet, "var(--violet)", "Term sheet")}${seg(g.pending, "var(--amber)", "Pending")}${gap > 0 ? `<div class="seg" style="flex:${gap} 1 0;background:transparent"></div>` : ""}</div>`;
  const pctT = Math.round((g.committed / ROUND_TARGET) * 100);
  const leg = [
    ["var(--green)", "Committed", g.committed, n.committed],
    ["var(--violet)", "Term sheet", g.termsheet, n.termsheet],
    ["var(--amber)", "Pending", g.pending, n.pending],
    ["var(--slate)", "Off the table", g.lost, n.lost],
  ];
  return `<div class="capwrap"><div class="caph"><span class="t">Capital flow — ${money(g.committed)} committed of ${money(ROUND_TARGET)} target (${pctT}%)</span><span class="r">Total on the table: ${money(totMin)}–${money(totMax)} across ${priced.length} investors</span></div>${bar}<div class="caplegend">${leg.map(([c, l, val, cnt]) => `<div class="cl"><span class="sw" style="background:${c}"></span><b>${money(val)}</b> <span>${l} · ${cnt}</span></div>`).join("")}</div></div>`;
}
function dealCap(id) {
  const d = deal(id);
  const v = vc(id);
  return d && d.value ? num$(d.value) : (v && v.check_avg) || 0;
}
function pipelineSeries() {
  const events = [...CRM.log]
    .filter((e) => e.id && e.id !== "_system" && vc(e.id))
    .sort((a, b) => a.ts - b.ts);
  const stageOf = {};
  let submittedCum = 0;
  const pts = [];
  const snap = (ts) => {
    let committed = 0,
      termsheet = 0,
      pending = 0;
    for (const id in stageOf) {
      const st = stageOf[id],
        c = dealCap(id);
      if (st === "signed") committed += c;
      else if (st === "diligence" || st === "termsheet") termsheet += c;
      else if (st === "denied" || st === "past") continue;
      else pending += c;
    }
    pts.push({
      ts,
      committed,
      termsheet,
      pending,
      active: committed + termsheet + pending,
      submittedCum,
    });
  };
  events.forEach((e) => {
    if (e.type === "submitted") {
      if (!(e.id in stageOf)) submittedCum += dealCap(e.id);
      stageOf[e.id] = "submitted";
    } else if (e.type === "advance") {
      const s = L2S[e.detail];
      if (s) stageOf[e.id] = s;
    } else if (e.type === "signed" || e.type === "committed") stageOf[e.id] = "signed";
    else if (e.type === "denied" || e.type === "passed") stageOf[e.id] = "denied";
    else if (e.type === "past") stageOf[e.id] = "past";
    else if (e.type === "reopen") stageOf[e.id] = "submitted";
    else if (e.type === "removed") {
      delete stageOf[e.id];
    } else return;
    snap(e.ts);
  });
  if (pts.length) pts.push({ ...pts[pts.length - 1], ts: Date.now() });
  return pts;
}
function renderTrend() {
  const pts = pipelineSeries();
  if (pts.length < 2) return "";
  const W = 760,
    H = 230,
    padL = 54,
    padR = 16,
    padT = 16,
    padB = 26;
  const t0 = pts[0].ts,
    t1 = pts[pts.length - 1].ts,
    span = Math.max(1, t1 - t0);
  const ymax =
    Math.max(ROUND_TARGET, ...pts.map((p) => Math.max(p.active, p.submittedCum))) * 1.12 || ROUND_TARGET;
  const X = (ts) => padL + ((ts - t0) / span) * (W - padL - padR);
  const Y = (v) => H - padB - (v / ymax) * (H - padT - padB);
  const path = (key) =>
    pts.map((p, i) => (i ? "L" : "M") + X(p.ts).toFixed(1) + " " + Y(p[key]).toFixed(1)).join(" ");
  const area =
    path("active") + ` L ${X(t1).toFixed(1)} ${Y(0).toFixed(1)} L ${X(t0).toFixed(1)} ${Y(0).toFixed(1)} Z`;
  const ty = Y(ROUND_TARGET);
  let yaxis = "";
  for (let i = 0; i <= 4; i++) {
    const val = (ymax / 4) * i,
      yy = Y(val);
    yaxis += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" style="stroke:var(--line);stroke-width:1"/><text x="${padL - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end" font-size="9" style="fill:var(--muted)">$${(val / 1e6).toFixed(1)}M</text>`;
  }
  const fmtd = (ts) => new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
  let xaxis = "";
  [0, 0.5, 1].forEach((fr) => {
    const ts = t0 + span * fr,
      xx = X(ts);
    xaxis += `<text x="${xx.toFixed(1)}" y="${H - 7}" text-anchor="middle" font-size="9" style="fill:var(--muted)">${fmtd(ts)}</text>`;
  });
  return `<div class="capwrap"><div class="caph"><span class="t">Cumulative pipeline over time</span><span class="r"><span style="color:var(--muted)">━ submitted</span> · <span style="color:var(--blue)">━ active</span> · <span style="color:var(--green)">━ committed</span></span></div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">${yaxis}
<line x1="${padL}" y1="${ty.toFixed(1)}" x2="${W - padR}" y2="${ty.toFixed(1)}" style="stroke:var(--brand);stroke-width:1;stroke-dasharray:4 4"/><text x="${W - padR}" y="${(ty - 4).toFixed(1)}" text-anchor="end" font-size="9" style="fill:var(--brand)">target ${moneyM(ROUND_TARGET)}</text>
<path d="${area}" style="fill:color-mix(in srgb,var(--blue) 13%,transparent)"/>
<path d="${path("submittedCum")}" fill="none" style="stroke:var(--muted);stroke-width:1.4;stroke-dasharray:3 3"/>
<path d="${path("active")}" fill="none" style="stroke:var(--blue);stroke-width:2"/>
<path d="${path("committed")}" fill="none" style="stroke:var(--green);stroke-width:2.5"/>
${xaxis}
    </svg></div>`;
}
function renderPipe() {
  const c = counts();
  const stageCap = {};
  BOARDCOLS.forEach((s) => (stageCap[s] = 0));
  Object.entries(CRM.deals).forEach(([id, d]) => {
    if (d._noteonly) return;
    if (vc(id) && stageCap[d.stage] != null) stageCap[d.stage] += dealCap(id);
  });
  const f$ = (x) =>
    !x
      ? "$0"
      : x >= 1e6
        ? "$" + (x / 1e6).toFixed(x % 1e6 ? 2 : 0) + "M"
        : x >= 1e3
          ? "$" + Math.round(x / 1e3) + "K"
          : "$" + Math.round(x);
  const fnode = (k) =>
    `<div class="fnode ${c[k] ? "hasdeals" : ""}" style="color:${STAGE[k].color}"><div class="fn-n">${c[k]}</div><div class="fn-l">${STAGE[k].label}</div><div class="fn-amt">${f$(stageCap[k])}</div></div>`;
  const prog = FLOW.slice(0, -1);
  const flow =
    prog.map((k, i) => fnode(k) + (i < prog.length - 1 ? '<div class="farrow"></div>' : "")).join("") +
    '<div class="farrow"></div><div class="fsplit"><div class="fbranch"><span class="flabel yes">YES</span>' +
    fnode("signed") +
    '</div><div class="fbranch"><span class="flabel no">NO</span>' +
    fnode("denied") +
    '</div><div class="fbranch"><span class="flabel no" style="opacity:.6">PAST</span>' +
    fnode("past") +
    "</div></div>";
  const dealsIn = Object.entries(CRM.deals).filter(([id, d]) => !d._noteonly);
  let board = "";
  BOARDCOLS.forEach((stage) => {
    const items = dealsIn
      .filter(([id, d]) => d.stage === stage)
      .map(([id]) => vc(id))
      .filter(Boolean)
      .sort((a, b) => b.fit_score - a.fit_score);
    const term = isTerm(stage);
    board += `<div class="col" data-stage="${stage}"><div class="col-h"><span class="dot" style="background:${STAGE[stage].color}"></span>${STAGE[stage].label}<span class="n">${items.length}</span></div><div class="col-amt" style="color:${STAGE[stage].color}">${f$(stageCap[stage])}</div>`;
    if (!items.length) board += `<div class="placeholder">—</div>`;
    items.forEach((v) => {
      const p = v.best_partner || {};
      const dd = deal(v.id);
      const cn = ((dd && dd.connections) || []).filter((c) => c && c.name).length;
      const dcap = dealCap(v.id);
      board += `<div class="dcard" data-id="${v.id}" draggable="true"><div class="df" data-open><span class="ds" style="background:${scoreColor(v.fit_score)}">${v.fit_score}</span>${esc(v.firm)}</div><div class="dm">${esc(p.name || "—")}${dcap ? ` · <b style="color:var(--ink2)">${f$(dcap)}${dd && dd.value ? "" : "*"}</b>` : ""}${cn ? ` · <span style="color:var(--brand)">◇ ${cn}</span>` : ""}</div>
  <div class="dbtns">${term ? `<button class="re" data-reopen>↺ Reopen</button><button class="intro" data-intro>✉ Intro</button>` : `<button class="adv" data-adv>${stage === "termsheet" ? "✓ Sign" : "Advance →"}</button><button class="no" data-pass>Deny</button>`}</div><button class="dcard-rm" data-remove>✕ Remove from pipeline</button></div>`;
    });
    board += `</div>`;
  });
  const activeDeals = dealsIn.filter(([id, d]) => d.stage !== "denied" && d.stage !== "past");
  const activeCap = activeDeals.reduce((t, [id]) => t + dealCap(id), 0);
  const anyEst = activeDeals.some(([id, d]) => !d.value && dealCap(id));
  const valline = activeCap
    ? `<div class="counted" style="margin:-8px 0 14px">Active pipeline: <b style="color:var(--ink)">${f$(activeCap)}</b> across ${activeDeals.length} deal${activeDeals.length !== 1 ? "s" : ""}${anyEst ? ` · <span style="color:var(--muted)">*estimated from avg check — set a Deal value to lock it</span>` : ""}</div>`
    : "";
  document.getElementById("mbody").innerHTML = dealsIn.length
    ? `${renderCapital()}<div class="flowwrap"><div class="flow">${flow}</div></div>${valline}<div class="board">${board}</div>${renderTrend()}`
    : `<div class="flowwrap"><div class="flow">${flow}</div></div><div class="empty">No deals yet. Submit an investor from the Directory to start one.</div>`;
  document.querySelectorAll(".dcard").forEach((card) => {
    const id = card.dataset.id;
    card.querySelector("[data-open]").onclick = () => openDrawer(id);
    const a = card.querySelector("[data-adv]");
    if (a) a.onclick = () => advance(id);
    const ps = card.querySelector("[data-pass]");
    if (ps) ps.onclick = () => pass(id);
    const r = card.querySelector("[data-reopen]");
    if (r) r.onclick = () => reopen(id);
    const it = card.querySelector("[data-intro]");
    if (it) it.onclick = () => openModal(vc(id));
    const rm = card.querySelector("[data-remove]");
    if (rm) rm.onclick = () => removeDeal(id);
  });
  // drag cards between stage columns
  document.querySelectorAll(".dcard").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", card.dataset.id);
      e.dataTransfer.effectAllowed = "move";
      setTimeout(() => card.classList.add("dragging"), 0);
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });
  document.querySelectorAll(".col").forEach((col) => {
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      col.classList.add("dragover");
    });
    col.addEventListener("dragleave", (e) => {
      if (!col.contains(e.relatedTarget)) col.classList.remove("dragover");
    });
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.classList.remove("dragover");
      const id = e.dataTransfer.getData("text/plain"),
        st = col.dataset.stage;
      if (id && st && deal(id) && deal(id).stage !== st) setStage(id, st);
    });
  });
  // click-drag empty board area to pan horizontally
  const bd = document.querySelector(".board");
  if (bd)
    bd.addEventListener("mousedown", (e) => {
      if (e.target.closest(".dcard") || e.target.closest("button") || e.target.closest("a")) return;
      const startX = e.pageX,
        startL = bd.scrollLeft;
      bd.classList.add("panning");
      const mv = (ev) => {
        bd.scrollLeft = startL - (ev.pageX - startX);
      };
      const up = () => {
        bd.classList.remove("panning");
        document.removeEventListener("mousemove", mv);
        document.removeEventListener("mouseup", up);
      };
      document.addEventListener("mousemove", mv);
      document.addEventListener("mouseup", up);
    });
}
