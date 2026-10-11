// ---- deck breakdown ----
// Bold **spans** and a lightweight markdown pass for the stored critique
// (## headings, - bullets, Before:/After: lines). Escape first, then promote.
const boldMd = (s) => s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
function critiqueHTML(text) {
  const e = (s) => s.replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[m]);
  let out = "",
    inList = false;
  const flush = () => {
    if (inList) {
      out += "</ul>";
      inList = false;
    }
  };
  String(text || "")
    .split(/\n/)
    .forEach((raw) => {
      const line = raw.trim();
      if (!line) {
        flush();
        return;
      }
      if (line.startsWith("## ")) {
        flush();
        out += `<h4>${e(line.slice(3))}</h4>`;
        return;
      }
      if (/^[-*]\s+/.test(line)) {
        if (!inList) {
          out += "<ul>";
          inList = true;
        }
        out += `<li>${boldMd(e(line.replace(/^[-*]\s+/, "")))}</li>`;
        return;
      }
      flush();
      out += `<p class="${/^(before|after):/i.test(line) ? "ba" : ""}">${boldMd(e(line))}</p>`;
    });
  flush();
  return out;
}
function renderDeck() {
  const p = (COMPANY && COMPANY.profile) || {};
  const sc = p.deck_score;
  const mb = document.getElementById("mbody");
  if (!sc || !sc.dimensions) {
    mb.innerHTML = `<div class="empty">No deck score yet. It's generated when your deck is analyzed.</div>`;
    return;
  }
  const o = sc.overall || 0,
    pct = Math.max(0, Math.min(1, o / 5));
  const col =
    o >= 4.2 ? "var(--green)" : o >= 3.4 ? "var(--brand)" : o >= 2.5 ? "var(--amber)" : "var(--red)";
  const stage = (sc.stage_basis || "seed").replace(/-/g, " ");
  let html = `<div class="dkhero">
    <div class="dkring" style="background:conic-gradient(${col} ${(pct * 360).toFixed(0)}deg,var(--surface2) 0)"><div class="in"><div class="dkbig" style="color:${col}">${o}<span>/5</span></div></div></div>
    <div style="flex:1;min-width:210px"><div class="dkband">${esc(sc.band || "")}</div>
<div class="dkbasis">Scored against what's normal at ${esc(stage)} stage — eight dimensions a partner weighs, weighted for your stage, weakest first.</div></div>
  </div>`;
  html += `<div class="dksec">Scorecard</div>`;
  html += sc.dimensions
    .map(
      (d) => `<div class="dkrow${d.score <= 2 ? " low" : ""}">
    <div><div class="dkl">${esc(d.label)}</div><div class="dksc">${d.score} / 5</div></div>
    <div><div class="dkbar"><i style="width:${((d.score / 5) * 100).toFixed(0)}%"></i></div></div>
    <div><div class="dke">${esc(d.evidence || "")}</div>${d.fix ? `<div class="dkfix"><b>Fix:</b> ${esc(d.fix)}</div>` : ""}</div>
  </div>`,
    )
    .join("");
  if ((p.gaps || []).length)
    html += `<div class="dksec">Questions your deck doesn't answer yet</div><div class="dkgaps"><ul>${p.gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul></div>`;
  if (p.critique)
    html += `<div class="dksec">An investor's critique</div><div class="dkcrit">${critiqueHTML(p.critique)}</div>`;
  mb.innerHTML = html;
  enterRows(".dkrow", mb);
}
