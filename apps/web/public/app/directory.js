// ---- directory table ----
function dirFiltered() {
  let a = VCS.filter((v) => {
    if (isTrashed(v.id)) return false;
    if (S.type && v.type !== S.type) return false;
    if (S.tier && v.tier !== S.tier) return false;
    if (S.pipe === "in" && !(deal(v.id) && !deal(v.id)._noteonly)) return false;
    if (S.pipe === "out" && deal(v.id) && !deal(v.id)._noteonly) return false;
    if (S.cats.size && !(v.category || []).some((c) => S.cats.has(c))) return false;
    if (S.checks.size && !S.checks.has(checkBucket(v.check_avg))) return false;
    if (S.q) {
      const h = [
        v.firm,
        v.thesis,
        v.fit_rationale,
        (v.best_partner || {}).name,
        (v.relevant_portfolio || []).join(" "),
        (v.category || []).join(" "),
      ]
        .join(" ")
        .toLowerCase();
      if (!h.includes(S.q.toLowerCase())) return false;
    }
    return true;
  });
  const k = sortState.key,
    dir = sortState.dir === "asc" ? 1 : -1;
  a.sort((x, y) => {
    if (k === "firm") return x.firm.localeCompare(y.firm) * dir;
    if (k === "type") return ((x.type || "").localeCompare(y.type || "") || y.fit_score - x.fit_score) * dir;
    if (k === "stage") {
      const sx = deal(x.id) ? BOARDCOLS.indexOf(deal(x.id).stage) : -1,
        sy = deal(y.id) ? BOARDCOLS.indexOf(deal(y.id).stage) : -1;
      return (sx - sy || y.fit_score - x.fit_score) * dir;
    }
    if (k === "check")
      return (
        ((x.check_avg == null ? -1 : x.check_avg) - (y.check_avg == null ? -1 : y.check_avg) ||
          y.fit_score - x.fit_score) * dir
      );
    return (x.fit_score - y.fit_score) * dir;
  });
  return a;
}
// The bundled investor list ships as facts with no fit score attached — a score
// written for one company is misinformation for the next. So the board says so
// out loud rather than showing a number that means nothing, and offers the one
// action that fixes it.
function scoreBanner() {
  const st = (COMPANY.score || {}).status || "idle";
  const unscored = VCS.filter((v) => v.scored === false).length;
  if (st === "scoring") {
    const done = (COMPANY.score || {}).done || 0;
    return `<div class="scorebar running"><span class="spin"></span><div><b>Scoring against your deck…</b><div class="sbsub">${done} rated so far. This runs in the background — keep working, or leave and come back.</div></div></div>`;
  }
  if (st === "failed") {
    return `<div class="scorebar bad"><div><b>Scoring stopped.</b><div class="sbsub">${esc((COMPANY.score || {}).error || "")}</div></div><button class="btn" id="runscore">Try again</button></div>`;
  }
  if (!unscored) return "";
  return `<div class="scorebar"><div><b>${unscored} investors are not scored yet.</b><div class="sbsub">They came with the list, so their fit numbers are placeholders. Scoring reads each firm's thesis against your deck and replaces them.</div></div><button class="btn" id="runscore">Score against my deck</button></div>`;
}

async function runScore() {
  const b = document.getElementById("runscore");
  if (b) {
    b.disabled = true;
    b.textContent = "Starting…";
  }
  const r = await fetch("/api/score", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    toast(j.error || "Could not start scoring");
    if (b) {
      b.disabled = false;
      b.textContent = "Score against my deck";
    }
    return;
  }
  COMPANY.score = { status: "scoring", done: 0 };
  renderDir();
  pollScore();
}

// Polls the company row the background job writes to. Every tick re-renders, so
// the count moves while the run is going rather than jumping at the end.
let scorePoll;
function pollScore() {
  clearInterval(scorePoll);
  scorePoll = setInterval(async () => {
    const m = await fetch("/api/me")
      .then((r) => r.json())
      .catch(() => null);
    if (!m || !m.company) return;
    COMPANY = m.company;
    const st = (COMPANY.score || {}).status;
    if (st === "scoring") {
      if (S.view === "dir") renderDir();
      return;
    }
    clearInterval(scorePoll);
    await reloadData();
    renderHead();
    if (st === "ready") toast(`Scored ${(COMPANY.score || {}).done || 0} investors against your deck`);
    if (st === "failed") toast("Scoring stopped — see the banner");
  }, 5000);
}

function renderDir() {
  const rows = dirFiltered();
  const withChk = rows.filter((r) => r.check_avg != null);
  const med = median(withChk.map((r) => r.check_avg));
  const est = withChk.length
    ? ` · median check <b style="color:var(--ink)">${fmtCheck(med)}</b> · ~${Math.max(1, Math.ceil(ROUND_TARGET / med))} checks fill a ${moneyM(ROUND_TARGET)} round`
    : "";
  const cols = [
    ["score", "Fit"],
    ["firm", "Firm"],
    ["type", "Type"],
    ["cat", "Categories"],
    ["partner", "Best partner"],
    ["check", "Avg check"],
    ["stage", "Stage"],
  ];
  const PS = S.pageSize === "all" ? rows.length || 1 : S.pageSize;
  const maxPage = Math.max(1, Math.ceil(rows.length / PS));
  if (S.page > maxPage) S.page = maxPage;
  if (S.page < 1) S.page = 1;
  const start = (S.page - 1) * PS,
    pageRows = rows.slice(start, start + PS);
  const live = VCS.filter((v) => !isTrashed(v.id));
  const inPipe = (v) => deal(v.id) && !deal(v.id)._noteonly;
  const tabs = [
    ["out", "Discovery", live.filter((v) => !inPipe(v)).length],
    ["in", "Submitted", live.filter(inPipe).length],
    ["", "All", live.length],
  ];
  const tabbar = `<div class="dirtabs">${tabs.map(([k, l, n]) => `<button class="dtab ${S.pipe === k ? "on" : ""}" data-pipe="${k}">${l} <span class="dtc">${n}</span></button>`).join("")}</div>`;
  let html =
    `${scoreBanner()}${tabbar}<div class="counted">${rows.length} of ${VCS.length} investors${est} <button class="btn sm" id="addinv" style="margin-left:10px">＋ Add investor</button></div><div class="tablewrap"><table><thead><tr>` +
    cols
      .map(
        ([k, l]) =>
          `<th class="${["score", "firm", "type", "check", "stage"].includes(k) ? "sortable" : ""}" data-k="${k}">${l}${sortState.key === k ? (sortState.dir === "asc" ? " ▲" : " ▼") : ""}</th>`,
      )
      .join("") +
    `</tr></thead><tbody>`;
  pageRows.forEach((v) => {
    const p = v.best_partner || {};
    const d = deal(v.id);
    const inp = d && !d._noteonly;
    html += `<tr data-id="${v.id}">
<td><div class="sc" style="background:${scoreColor(v.fit_score)}">${v.fit_score}</div></td>
<td class="fcell"><b><span class="tierdot" title="${v.tier}" style="background:${v.tier === "seed" ? "var(--brand)" : v.tier === "custom" ? "var(--amber)" : "var(--muted)"}"></span>${esc(v.firm)}</b><div class="fx">${esc(v.hq || "")}${v.check_size && v.check_size !== "unknown" ? " · " + esc(v.check_size) : ""}</div></td>
<td class="typ">${esc(v.type || "VC")}</td>
<td><div class="tags">${(v.category || [])
      .slice(0, 3)
      .map((c) => `<span class="tag">${esc(c)}</span>`)
      .join("")}</div></td>
<td class="fcell"><b>${esc(p.name || "—")}</b><div class="fx">${esc(p.title || "")}</div></td>
<td class="fcell"><b>${fmtCheck(v.check_avg)}</b>${v.check_min != null ? `<div class="fx">${fmtCheck(v.check_min)}–${fmtCheck(v.check_max)}</div>` : ""}</td>
<td><div style="display:flex;align-items:center;gap:8px;justify-content:space-between">${inp ? `<span class="stagepill" style="background:${STAGE[d.stage].color}">${STAGE[d.stage].label}</span>` : `<button class="subbtn" data-submit>Submit ↧</button>`}<button class="rowtrash" data-trash title="Move to trash" aria-label="Move to trash">×</button></div></td>
    </tr>`;
  });
  html += `</tbody></table></div>`;
  const end = Math.min(start + PS, rows.length);
  const psizes = [25, 50, 100, "all"];
  html += `<div class="pager">
    <button data-pg="prev" ${S.page <= 1 ? "disabled" : ""}>‹ Prev</button>
    <span>${rows.length ? start + 1 : 0}–${end} of ${rows.length} · page ${S.page}/${maxPage}</span>
    <button data-pg="next" ${S.page >= maxPage ? "disabled" : ""}>Next ›</button>
    <select data-pg="size">${psizes.map((n) => `<option value="${n}"${String(S.pageSize) === String(n) ? " selected" : ""}>${n === "all" ? "Show all" : n + " / page"}</option>`).join("")}</select>
  </div>`;
  const mb = document.getElementById("mbody");
  mb.innerHTML = html;
  enterRows("tbody tr", mb);
  mb.querySelectorAll("th.sortable").forEach(
    (th) =>
      (th.onclick = () => {
        const k = th.dataset.k;
        if (sortState.key === k) sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
        else {
          sortState.key = k;
          sortState.dir = k === "firm" ? "asc" : "desc";
        }
        S.page = 1;
        renderDir();
      }),
  );
  mb.querySelector("[data-pg=prev]").onclick = () => {
    if (S.page > 1) {
      S.page--;
      renderDir();
      window.scrollTo ? 0 : 0;
      document.querySelector(".main").scrollTop = 0;
    }
  };
  mb.querySelector("[data-pg=next]").onclick = () => {
    if (S.page < maxPage) {
      S.page++;
      renderDir();
      document.querySelector(".main").scrollTop = 0;
    }
  };
  mb.querySelector("[data-pg=size]").onchange = (e) => {
    S.pageSize = e.target.value === "all" ? "all" : +e.target.value;
    S.page = 1;
    renderDir();
  };
  mb.querySelector("#addinv").onclick = openAddModal;
  const rs = mb.querySelector("#runscore");
  if (rs) rs.onclick = runScore;
  mb.querySelectorAll("[data-pipe]").forEach(
    (b) =>
      (b.onclick = () => {
        S.pipe = b.dataset.pipe;
        S.page = 1;
        renderDir();
      }),
  );
  mb.querySelectorAll("tbody tr").forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.closest("[data-submit]") || e.target.closest("[data-trash]")) return;
      openDrawer(tr.dataset.id);
    };
    const sb = tr.querySelector("[data-submit]");
    if (sb) sb.onclick = () => submit(tr.dataset.id);
    const tb = tr.querySelector("[data-trash]");
    if (tb)
      tb.onclick = (e) => {
        e.stopPropagation();
        trashInvestor(tr.dataset.id);
      };
  });
}
