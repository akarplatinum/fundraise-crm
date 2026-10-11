// ---- intro map (global) ----
function renderMap() {
  const hasName = (d) => (d.connections || []).some((c) => c && c.name);
  const entries = Object.entries(CRM.deals).filter(
    ([id, d]) => vc(id) && (!d._noteonly || hasName(d) || d.needIntro),
  );
  const legend = `<div class="legend"><div class="lg"><span style="background:var(--green)"></span>Strong tie</div><div class="lg"><span style="background:var(--amber)"></span>Medium</div><div class="lg"><span style="background:var(--slate)"></span>Weak</div><div class="lg"><span style="border-top:2px dashed var(--muted);width:20px;height:0"></span>No warm path</div></div>`;
  if (!entries.length) {
    document.getElementById("mbody").innerHTML =
      legend +
      `<div class="empty">No paths to map yet. Open an investor and add who can introduce you — the route shows here and on each deal.</div>`;
    return;
  }
  const withPath = entries.filter(([id, d]) => hasName(d)),
    needIntro = entries.filter(([id, d]) => !hasName(d) && d.needIntro),
    noPath = entries.filter(([id, d]) => !hasName(d) && !d.needIntro);
  const card = ([id, d]) => {
    const v = vc(id);
    const val = d.value ? ` · $${esc(d.value)}` : "";
    const stg = d._noteonly ? "planning" : STAGE[d.stage] ? STAGE[d.stage].label : "";
    return `<div class="mapcard"><div class="mt"><span class="sc" style="width:26px;height:26px;font-size:12px;border-radius:7px;background:${scoreColor(v.fit_score)}">${v.fit_score}</span>${esc(v.firm)}<span class="mtag">${stg}${val}</span><button class="ghost sm" data-open="${id}" style="margin-left:auto">Open</button></div><div class="mapwrap">${relMapSVG(v, d)}</div></div>`;
  };
  const sec = (t, n) =>
    `<div style="color:var(--muted);margin:4px 0 10px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:700">${t} (${n})</div>`;
  let html = legend;
  if (withPath.length) html += sec("Deals with intro paths", withPath.length) + withPath.map(card).join("");
  if (needIntro.length)
    html +=
      (withPath.length ? `<div style="height:8px"></div>` : "") +
      sec("Need to find an intro", needIntro.length) +
      needIntro.map(card).join("");
  if (noPath.length)
    html +=
      (withPath.length || needIntro.length ? `<div style="height:8px"></div>` : "") +
      sec("No warm path yet", noPath.length) +
      noPath.map(card).join("");
  const mb = document.getElementById("mbody");
  mb.innerHTML = html;
  mb.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => openDrawer(b.dataset.open)));
}
