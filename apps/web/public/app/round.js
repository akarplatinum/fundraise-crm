// ---- round builder ----
let RB = {
  target: 2.5e6,
  lead: null,
  minFit: 75,
  excluded: new Set(),
  preferWarm: true,
};
const TIEW = { strong: 3, medium: 2, weak: 1 };
const STAGE_PROB = {
  submitted: 0.05,
  intro: 0.1,
  meeting_accepted: 0.2,
  meeting_booked: 0.3,
  followup: 0.4,
  diligence: 0.6,
  termsheet: 0.85,
  signed: 1,
};
// intro-connection status (favor tracking): promised = they owe you an intro
const CONNSTATUS = [
  ["idea", "Idea"],
  ["asked", "Asked them"],
  ["promised", "Promised — owes you"],
  ["done", "Intro made ✓"],
  ["repay", "You owe them"],
];
const CSTAT = {
  idea: { l: "Idea", c: "var(--slate)" },
  asked: { l: "Asked", c: "var(--amber)" },
  promised: { l: "Owes you", c: "var(--cyan)" },
  done: { l: "Intro made", c: "var(--green)" },
  repay: { l: "You owe them", c: "var(--pink)" },
};
function warmthScore(v) {
  const d = deal(v.id);
  if (!d) return 0;
  let w = 0;
  if (!d._noteonly && d.stage && !isTerm(d.stage)) w += 1;
  const conns = (d.connections || []).filter((c) => c && c.name);
  if (conns.length) w += Math.max(...conns.map((c) => TIEW[c.strength] || 2)) * 2;
  return w;
}
function connCount(v) {
  const d = deal(v.id);
  return d ? (d.connections || []).filter((c) => c && c.name).length : 0;
}
function buildRound() {
  const inRound = Object.entries(CRM.deals)
    .filter(([id, d]) => !d._noteonly && d.stage !== "denied" && d.stage !== "past" && vc(id))
    .map(([id, d]) => ({ v: vc(id), d, cap: dealCap(id) }))
    .sort((a, b) => BOARDCOLS.indexOf(b.d.stage) - BOARDCOLS.indexOf(a.d.stage) || b.cap - a.cap);
  const sumBy = (f) => inRound.filter(f).reduce((t, x) => t + x.cap, 0);
  const activeCap = inRound.reduce((t, x) => t + x.cap, 0);
  const committedCap = sumBy((x) => x.d.stage === "signed");
  const softCap = sumBy((x) => ["meeting_booked", "followup", "diligence", "termsheet"].includes(x.d.stage));
  const expectedCap = inRound.reduce((t, x) => t + x.cap * (STAGE_PROB[x.d.stage] || 0), 0);
  const gap = Math.max(0, RB.target - activeCap);
  const inIds = new Set(inRound.map((x) => x.v.id));
  const pool = VCS.filter(
    (v) =>
      v.check_avg != null &&
      !inIds.has(v.id) &&
      !RB.excluded.has(v.id) &&
      v.fit_score >= RB.minFit &&
      !(deal(v.id) && (deal(v.id).stage === "denied" || deal(v.id).stage === "past")),
  ).sort((a, b) => (RB.preferWarm ? warmthScore(b) - warmthScore(a) : 0) || b.fit_score - a.fit_score);
  let rem = gap;
  const suggest = [];
  for (const v of pool) {
    if (rem <= 1e4) break;
    const alloc = Math.min(v.check_avg, rem);
    if (alloc <= 0) continue;
    suggest.push({ v, alloc });
    rem -= alloc;
  }
  return { inRound, activeCap, committedCap, softCap, expectedCap, gap, suggest };
}
function renderRound() {
  const { inRound, activeCap, committedCap, softCap, expectedCap, gap, suggest } = buildRound();
  const target = RB.target;
  const f$ = moneyM;
  const fits = [95, 90, 85, 80, 75, 70, 65, 0];
  const ctl = `<div class="rbctl">
    <div class="f"><label>Round target</label><input id="rb-target" type="text" value="${f$(target)}"></div>
    <div class="f"><label>Suggestions min-fit</label><select id="rb-minfit">${fits.map((f) => `<option value="${f}"${f === RB.minFit ? " selected" : ""}>${f === 0 ? "any" : f + "+"}</option>`).join("")}</select></div>
    <div class="f"><label>Prefer warm</label><button id="rb-warm" class="${RB.preferWarm ? "btn" : "ghost"} sm" style="height:36px">${RB.preferWarm ? "◇ On" : "Off"}</button></div>
  </div>`;
  // stacked progress toward target: committed(green) / soft=meeting+diligence(violet) / pending(amber)
  const pendCap = Math.max(0, activeCap - committedCap - softCap);
  const scale = Math.max(target, activeCap) || target;
  const seg = (val, color) =>
    val > 0 ? `<div class="seg" style="flex:${val} 1 0;background:${color}"></div>` : "";
  const expPos = Math.min(100, (expectedCap / scale) * 100);
  const bar = `<div style="position:relative;margin-top:16px">
    <div class="capbar" style="height:22px">${seg(committedCap, "var(--green)")}${seg(softCap, "var(--violet)")}${seg(pendCap, "var(--amber)")}${scale - activeCap > 0 ? `<div class="seg" style="flex:${scale - activeCap} 1 0;background:transparent"></div>` : ""}</div>
    <div style="position:absolute;top:-4px;bottom:-4px;left:${expPos}%;width:2px;background:var(--ink);border-radius:2px" title="Expected close"></div>
    <div style="position:absolute;top:-17px;left:${expPos}%;transform:translateX(-50%);font-size:9.5px;font-weight:700;color:var(--ink);white-space:nowrap">◆ exp ${f$(expectedCap)}</div>
  </div>`;
  const pctC = Math.round((committedCap / target) * 100),
    pctE = Math.round((expectedCap / target) * 100);
  const stat = `${bar}<div class="rbstat">
    <div><div class="n" style="color:var(--green)">${f$(committedCap)}</div><div class="l">committed · ${pctC}%</div></div>
    <div><div class="n">${f$(expectedCap)}</div><div class="l">expected close · ${pctE}%</div></div>
    <div><div class="n" style="color:var(--violet)">${f$(softCap)}</div><div class="l">soft (mtg+dd)</div></div>
    <div><div class="n">${f$(activeCap)}</div><div class="l">in round · ${inRound.length}</div></div>
    <div><div class="n" style="color:var(--brand)">${f$(target)}</div><div class="l">target</div></div>
    <div><div class="n">${gap > 1e4 ? f$(gap) : "$0"}</div><div class="l">gap to fill</div></div></div>`;
  // your round table
  const roundRows = inRound
    .map(({ v, d, cap }) => {
      const p = v.best_partner || {};
      const term = isTerm(d.stage);
      const cc = connCount(v);
      return `<tr data-id="${v.id}"><td><div class="sc" style="background:${scoreColor(v.fit_score)}">${v.fit_score}</div></td>
<td class="fcell"><b>${esc(v.firm)}</b><div class="fx">${esc(p.name || "")}${cc ? ` · <span style="color:var(--brand)">◇ ${cc}</span>` : ""}</div></td>
<td><span class="roletag" style="background:${STAGE[d.stage].color};color:#fff">${STAGE[d.stage].label}</span></td>
<td class="fcell"><b>${f$(cap)}</b><div class="fx">${d.value ? "set" : "est*"}</div></td>
<td style="white-space:nowrap">${term ? `<button class="ghost sm" data-reopen="${v.id}">↺ Reopen</button>` : `<button class="ghost sm" data-adv="${v.id}">${d.stage === "termsheet" ? "✓ Sign" : "Advance →"}</button> <button class="rm sm" data-drop="${v.id}">Deny</button> <button class="ghost sm" data-past="${v.id}">Past</button>`} <button class="rm sm" data-rmdeal="${v.id}" title="Remove from pipeline">✕ Remove</button></td></tr>`;
    })
    .join("");
  const roundTable = inRound.length
    ? `<div class="ssec" style="color:var(--muted);margin:2px 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:700">In your round · ${inRound.length}</div><div class="tablewrap"><table><thead><tr><th>Fit</th><th>Firm</th><th>Status</th><th>Amount</th><th></th></tr></thead><tbody>${roundRows}</tbody></table></div>`
    : `<div class="empty" style="padding:34px">Your round is empty. Add investors from the suggestions below, or submit from the Directory — they show here with live capital totals.</div>`;
  // suggestions to fill the gap
  const sugRows = suggest
    .map(({ v, alloc }) => {
      const p = v.best_partner || {};
      const cc = connCount(v);
      const w = warmthScore(v);
      return `<tr data-id="${v.id}"><td><div class="sc" style="background:${scoreColor(v.fit_score)}">${v.fit_score}</div></td>
<td class="fcell"><b>${esc(v.firm)}</b><div class="fx">${esc(p.name || "")}${v.hq ? " · " + esc(v.hq.split("(")[0].trim()) : ""}${cc ? ` · <span style="color:var(--brand)">◇ ${cc} warm</span>` : w ? ` · <span style="color:var(--muted)">◇ path</span>` : ""}</div></td>
<td class="typ">${esc(v.type)}</td>
<td class="fcell"><b>${fmtCheck(v.check_avg)}</b><div class="fx">${v.check_min != null ? fmtCheck(v.check_min) + "–" + fmtCheck(v.check_max) : ""}</div></td>
<td><b style="color:var(--brand)">${f$(alloc)}</b></td>
<td style="white-space:nowrap"><button class="btn sm" data-add="${v.id}">+ Add</button> <button class="ghost sm" data-skip="${v.id}">Skip</button></td></tr>`;
    })
    .join("");
  const sugTable =
    gap > 1e4
      ? suggest.length
        ? `<div style="height:18px"></div><div class="ssec" style="color:var(--muted);margin:2px 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:700">Suggested to fill the ${f$(gap)} gap · best fit${RB.preferWarm ? ", warm first" : ""}</div><div class="tablewrap"><table><thead><tr><th>Fit</th><th>Firm</th><th>Type</th><th>Avg check</th><th>Suggested</th><th></th></tr></thead><tbody>${sugRows}</tbody></table></div>`
        : `<div class="rbgap">No more suggestions at min-fit ${RB.minFit}+. Lower the min-fit to widen the pool.</div>`
      : `<div class="rbgap" style="background:color-mix(in srgb,var(--green) 12%,transparent);border-color:color-mix(in srgb,var(--green) 35%,transparent);color:var(--green)">Round fully allocated — ${f$(activeCap)} in from ${inRound.length} investors against a ${f$(target)} target.</div>`;
  const mb = document.getElementById("mbody");
  mb.innerHTML = ctl + stat + roundTable + sugTable;
  wireRoundCtl(mb);
  mb.querySelectorAll("[data-adv]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        advance(b.dataset.adv);
      }),
  );
  mb.querySelectorAll("[data-drop]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        pass(b.dataset.drop);
      }),
  );
  mb.querySelectorAll("[data-past]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        toPast(b.dataset.past);
      }),
  );
  mb.querySelectorAll("[data-reopen]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        reopen(b.dataset.reopen);
      }),
  );
  mb.querySelectorAll("[data-rmdeal]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        removeDeal(b.dataset.rmdeal);
      }),
  );
  mb.querySelectorAll("[data-add]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        submit(b.dataset.add);
      }),
  );
  mb.querySelectorAll("[data-skip]").forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        RB.excluded.add(b.dataset.skip);
        renderRound();
      }),
  );
  mb.querySelectorAll("tbody tr").forEach(
    (tr) =>
      (tr.onclick = (e) => {
        if (e.target.closest("button")) return;
        openDrawer(tr.dataset.id);
      }),
  );
}
function wireRoundCtl(mb) {
  const tgt = mb.querySelector("#rb-target");
  tgt &&
    tgt.addEventListener("change", () => {
      const n = parseFloat(tgt.value.replace(/[^0-9.]/g, ""));
      if (!isNaN(n) && n > 0) RB.target = n < 1000 ? n * 1e6 : n;
      renderRound();
    });
  const mf = mb.querySelector("#rb-minfit");
  mf &&
    (mf.onchange = (e) => {
      RB.minFit = +e.target.value;
      renderRound();
    });
  const wm = mb.querySelector("#rb-warm");
  wm &&
    (wm.onclick = () => {
      RB.preferWarm = !RB.preferWarm;
      renderRound();
    });
}
