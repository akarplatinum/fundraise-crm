// ---- drawer ----
function openDrawer(id) {
  drawerId = id;
  fillDrawer(id);
  const d = document.getElementById("drawer");
  d.classList.add("on");
  document.getElementById("scrim").classList.add("on");
  fx(d, { transform: ["translateX(100%)", "none"] }, SPRING);
  // Sections settle in behind the panel so the eye lands on the firm name
  // before the wall of thesis/portfolio text underneath it.
  enterRows(".dsec", document.getElementById("dwrap"));
}
function closeDrawer() {
  drawerId = null;
  const d = document.getElementById("drawer");
  document.getElementById("scrim").classList.remove("on");
  const a = fx(d, { transform: ["none", "translateX(100%)"] }, { duration: 0.2, easing: "ease-in" });
  // Class comes off only once the panel is out, or the CSS resting position
  // would snap it offscreen mid-animation.
  if (a && a.finished)
    a.finished.then(
      () => d.classList.remove("on"),
      () => d.classList.remove("on"),
    );
  else d.classList.remove("on");
}
function fillDrawer(id) {
  const v = vc(id);
  if (!v) return;
  const p = v.best_partner || {};
  const d = deal(id);
  const inp = d && !d._noteonly;
  const links = [
    p.email && `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>`,
    p.linkedin && `<a href="${esc(p.linkedin)}" target="_blank">LinkedIn</a>`,
    p.twitter_x && `<a href="${esc(p.twitter_x)}" target="_blank">X</a>`,
    v.website && `<a href="${esc(v.website)}" target="_blank">Site</a>`,
  ]
    .filter(Boolean)
    .join(" · ");
  const others = (v.other_partners || [])
    .filter((o) => o && o.name)
    .map(
      (o) =>
        esc(o.name) + (o.focus ? ` (${esc(o.focus)})` : "") + (o.email ? ` &lt;${esc(o.email)}&gt;` : ""),
    )
    .join(", ");
  let dealbar;
  if (inp) {
    const term = isTerm(d.stage);
    dealbar = `<div class="dealbar"><div class="row"><span class="tierdot" style="width:9px;height:9px;background:${STAGE[d.stage].color}"></span><select class="stagesel" data-setstage title="Set status">${BOARDCOLS.map((s) => `<option value="${s}"${d.stage === s ? " selected" : ""}>${STAGE[s].label}</option>`).join("")}</select>
${term ? `<button class="ghost sm" data-reopen>↺ Reopen</button>` : `<button class="adv2" data-adv>${d.stage === "termsheet" ? "✓ Sign" : "Advance →"}</button>`}
<button class="ghost sm" data-intro>✉ Intro</button>
<button class="rm sm" data-remove style="margin-left:auto">✕ Remove</button></div></div>`;
  } else {
    dealbar = `<div class="dealbar"><div class="row"><button class="btn sm" data-submit>Submit to pipeline ↧</button><button class="ghost sm" data-intro>✉ Create intro</button></div></div>`;
  }
  document.getElementById("dwrap").innerHTML = `
    <div class="dh"><div class="sc" style="background:${scoreColor(v.fit_score)}">${v.fit_score}</div><div><h2>${esc(v.firm)}</h2></div></div>
    <div class="dmeta">${esc(v.type || "VC")} · ${TIER_LABEL[v.tier] || v.tier} · ${esc(v.hq || "")}${v.check_size && v.check_size !== "unknown" ? " · " + esc(v.check_size) : ""}${(v.stages || []).length ? " · " + esc(v.stages.join("/")) : ""}</div>
    ${dealbar}
    <div class="dsec"><h4>Deal value</h4><div class="dealval"><span class="dval-lbl">$</span><input id="dealval" placeholder="target check or allocation, e.g. 500,000" value="${esc(d?.value || "")}"><span class="savedhint" id="dvhint">saved</span></div></div>
    <div class="dsec"><h4>Intro paths &amp; relationship map</h4><div class="mapwrap" id="relmap">${relMapSVG(v, d)}</div><datalist id="contactnames">${Object.keys(
      allContacts(),
    )
      .map((n) => `<option value="${esc(n)}"></option>`)
      .join(
        "",
      )}</datalist><div id="connlist">${((d && d.connections) || []).map((c, i) => connRow(c, i)).join("")}</div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="ghost sm" data-addconn>+ Add connection</button><button class="${d && d.needIntro ? "btn" : "ghost"} sm" data-needintro>${d && d.needIntro ? "Marked: need to find intro" : "Flag: need to find intro"}</button></div></div>
    <div class="dsec"><h4>Thesis</h4><p>${esc(v.thesis || "—")}</p></div>
    <div class="dsec"><h4>Why they fit</h4><p>${esc(v.fit_rationale || "—")}</p></div>
    ${(v.relevant_portfolio || []).length ? `<div class="dsec"><h4>Relevant portfolio</h4><ul>${v.relevant_portfolio.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
    <div class="dsec"><h4>Best-fit partner</h4><p class="pname">${esc(p.name || "—")}</p>${p.title ? `<p class="ptitle">${esc(p.title)}</p>` : ""}${p.focus ? `<p class="pfocus">${esc(p.focus)}</p>` : ""}${p.why_this_partner ? `<p>${esc(p.why_this_partner)}</p>` : ""}${links ? `<p class="plinks">${links}</p>` : ""}${others ? `<p class="pothers">Also: ${others}</p>` : ""}</div>
    <div class="dsec"><h4>Notes</h4><textarea placeholder="Notes on this investor…">${esc(d?.notes || "")}</textarea><span class="savedhint">saved</span></div>
    <div class="dsec"><p style="color:var(--muted);font-size:11.5px">${v.scored ? `Fit ${v.fit_score} · structural ${v.structural_score ?? "n/a"} · model ${v.researcher_score ?? "n/a"}` : "Not scored yet"}<br>Source: ${esc(TIER_LABEL[v.tier] || v.tier)}</p><button class="ghost sm" data-trashinv style="margin-top:10px;color:var(--red)">Move to trash</button></div>`;
  const w = document.getElementById("dwrap");
  const ta = w.querySelector("textarea");
  const hint = w.querySelector(".savedhint");
  let t;
  ta.oninput = () => {
    if (!deal(id)) CRM.deals[id] = { stage: "submitted", notes: "", ts: Date.now(), _noteonly: true };
    deal(id).notes = ta.value;
    clearTimeout(t);
    t = setTimeout(() => {
      save();
      hint.classList.add("on");
      setTimeout(() => hint.classList.remove("on"), 1100);
    }, 450);
  };
  const q = (s) => w.querySelector(s);
  q("[data-submit]") && (q("[data-submit]").onclick = () => submit(id));
  q("[data-adv]") && (q("[data-adv]").onclick = () => advance(id));
  q("[data-setstage]") && (q("[data-setstage]").onchange = (e) => setStage(id, e.target.value));
  q("[data-pass]") && (q("[data-pass]").onclick = () => pass(id));
  q("[data-past]") && (q("[data-past]").onclick = () => toPast(id));
  q("[data-reopen]") && (q("[data-reopen]").onclick = () => reopen(id));
  q("[data-remove]") && (q("[data-remove]").onclick = () => removeDeal(id));
  q("[data-intro]").onclick = () => openModal(v);
  q("[data-trashinv]") && (q("[data-trashinv]").onclick = () => trashInvestor(id));
  const dv = q("#dealval");
  let tv;
  dv &&
    dv.addEventListener("input", () => {
      setDealValue(id, dv.value);
      const dh = q("#dvhint");
      clearTimeout(tv);
      tv = setTimeout(() => {
        if (dh) {
          dh.classList.add("on");
          setTimeout(() => dh.classList.remove("on"), 1000);
        }
      }, 300);
    });
  q("[data-addconn]") && (q("[data-addconn]").onclick = () => addConn(id));
  q("[data-needintro]") && (q("[data-needintro]").onclick = () => toggleNeedIntro(id));
  w.querySelectorAll(".conn").forEach((row) => {
    const i = +row.dataset.ci;
    row.querySelectorAll("[data-cf]").forEach((inp) => {
      const f = inp.dataset.cf;
      inp.addEventListener(inp.tagName === "SELECT" ? "change" : "input", () =>
        updateConn(id, i, f, inp.value),
      );
    });
    const rb = row.querySelector("[data-rmconn]");
    rb && (rb.onclick = () => removeConn(id, i));
  });
}
