// ---- view switch ----
function switchView(v) {
  S.view = v;
  drawerId && closeDrawer();
  document
    .querySelectorAll("#snav button,#mobnav button")
    .forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  renderHead();
  renderSidebar();
  renderStats();
  renderSideCounts();
  if (v === "dir") renderDir();
  if (v === "deck") renderDeck();
  if (v === "pipe") renderPipe();
  if (v === "map") renderMap();
  if (v === "contacts") renderContacts();
  if (v === "round") renderRound();
  if (v === "competitors") renderCompetitors();
  if (v === "trash") renderTrash();
  if (v === "outbox") loadOutbox().then(renderOutbox);
  if (v === "log") renderLog();
}
function renderHead() {
  const unscored = VCS.filter((v) => v.scored === false).length;
  const h = {
    dir: [
      "Directory",
      unscored
        ? `${VCS.length} investors · ${unscored} not yet scored against your deck`
        : VCS.length + " scored investors",
    ],
    deck: ["Deck score", "How your deck reads to a partner"],
    pipe: ["Pipeline", "Deals through the raise"],
    map: ["Intro map", "Who can introduce you"],
    contacts: ["Intros", "Your network & open favors"],
    round: ["Round", "Live round vs target"],
    competitors: ["Competitors", "Who your deck says you compete with"],
    trash: ["Trash", "Removed investors"],
    outbox: ["Outbox", "Email that goes out from your own mailbox"],
    log: ["Activity", "Recent changes"],
  }[S.view];
  const search =
    S.view === "dir"
      ? `<input id="dirsearch" class="dirsearch" autocomplete="off" placeholder="Search investors: firm, partner, thesis, category…" value="${esc(S.q)}">`
      : "";
  document.getElementById("mhead").innerHTML = `<h1>${h[0]}</h1><div class="sub">${h[1]}</div>${search}`;
  const ds = document.getElementById("dirsearch");
  if (ds)
    ds.oninput = (e) => {
      S.q = e.target.value;
      S.page = 1;
      renderDir();
    };
}
function renderStats() {
  const inPipe = Object.values(CRM.deals).filter((d) => !d._noteonly && !isTerm(d.stage)).length;
  const committed = Object.values(CRM.deals).filter((d) => d.stage === "signed").length;
  const t = {};
  VCS.forEach((v) => (t[v.tier] = (t[v.tier] || 0) + 1));
  document.getElementById("sfoot").innerHTML =
    `<div class="st"><b>${VCS.length}</b><span>investors</span></div><div class="st"><b>${inPipe}</b><span>active</span></div>` +
    `<div class="st"><b>${committed}</b><span>committed</span></div><div class="st"><b>${CRM.log.length}</b><span>log events</span></div>` +
    `<div class="keyline"><span class="keydot" style="background:${AI_READY ? "var(--brand)" : "var(--red)"}"></span>${AI_READY ? "AI ready" : "AI not set up"}</div>`;
}
function renderSideCounts() {
  document.getElementById("ct-dir").textContent = VCS.length;
  document.getElementById("ct-pipe").textContent = Object.values(CRM.deals).filter(
    (d) => !d._noteonly,
  ).length;
  document.getElementById("ct-log").textContent = CRM.log.length;
  const mc = document.getElementById("ct-map");
  if (mc)
    mc.textContent = Object.values(CRM.deals).filter(
      (d) => (d.connections || []).some((c) => c && c.name) || d.needIntro,
    ).length;
  const cc = document.getElementById("ct-contacts");
  if (cc) cc.textContent = Object.keys(allContacts()).length;
  const tc = document.getElementById("ct-trash");
  if (tc) tc.textContent = (CRM.trash || []).length;
}

// ---- sidebar (contextual) ----
function renderSidebar() {
  const b = document.getElementById("sbody");
  if (S.view === "dir") {
    const cats = {};
    VCS.forEach((v) => (v.category || []).forEach((c) => (cats[c] = (cats[c] || 0) + 1)));
    const types = [...new Set(VCS.map((v) => v.type))].sort();
    b.innerHTML = `<div class="ssec">Search</div><input class="sinput" id="q" placeholder="firm, partner, thesis…" value="${esc(S.q)}">
<div class="ssec">Tier</div><div class="schips" id="tierchips">
  <button class="schip ${S.tier === "" ? "on" : ""}" data-tier="">All</button>
  <button class="schip ${S.tier === "seed" ? "on" : ""}" data-tier="seed">Curated</button>
  <button class="schip ${S.tier === "fund-list" ? "on" : ""}" data-tier="fund-list">Fund list</button>
  <button class="schip ${S.tier === "researched" ? "on" : ""}" data-tier="researched">Found by research</button></div>
<div class="ssec">Type & stage</div>
<select class="sselect" id="ftype"><option value="">All types</option>${types.map((t) => `<option ${S.type === t ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
<select class="sselect" id="fpipe"><option value="">All (pipeline)</option><option value="in" ${S.pipe === "in" ? "selected" : ""}>In pipeline</option><option value="out" ${S.pipe === "out" ? "selected" : ""}>Not submitted</option></select>
<div class="ssec">Check size (avg)</div><div class="schips" id="checkchips">${CHECKB.map(([k, l]) => {
      const n = VCS.filter((v) => checkBucket(v.check_avg) === k).length;
      return `<button class="schip ${S.checks.has(k) ? "on" : ""}" data-chk="${k}">${l} ${n}</button>`;
    }).join("")}</div>
<div class="ssec">Category</div><div class="schips" id="catchips">${Object.entries(cats)
      .sort((a, c) => c[1] - a[1])
      .map(
        ([c, n]) =>
          `<button class="schip ${S.cats.has(c) ? "on" : ""}" data-cat="${esc(c)}">${esc(c)} ${n}</button>`,
      )
      .join("")}</div>`;
    document.getElementById("q").oninput = (e) => {
      S.q = e.target.value;
      S.page = 1;
      renderDir();
    };
    b.querySelector("#checkchips").onclick = (e) => {
      const x = e.target.closest("[data-chk]");
      if (!x) return;
      const k = x.dataset.chk;
      S.checks.has(k) ? S.checks.delete(k) : S.checks.add(k);
      x.classList.toggle("on");
      S.page = 1;
      renderDir();
    };
    document.getElementById("ftype").onchange = (e) => {
      S.type = e.target.value;
      S.page = 1;
      renderDir();
    };
    document.getElementById("fpipe").onchange = (e) => {
      S.pipe = e.target.value;
      S.page = 1;
      renderDir();
    };
    b.querySelector("#tierchips").onclick = (e) => {
      const x = e.target.closest("[data-tier]");
      if (!x) return;
      S.tier = x.dataset.tier;
      b.querySelectorAll("#tierchips .schip").forEach((c) => c.classList.toggle("on", c === x));
      S.page = 1;
      renderDir();
    };
    b.querySelector("#catchips").onclick = (e) => {
      const x = e.target.closest("[data-cat]");
      if (!x) return;
      const c = x.dataset.cat;
      S.cats.has(c) ? S.cats.delete(c) : S.cats.add(c);
      x.classList.toggle("on");
      S.page = 1;
      renderDir();
    };
  } else if (S.view === "log") {
    const kinds = [
      ["", "All"],
      ["submitted", "Submits"],
      ["advance", "Advances"],
      ["signed", "Signed"],
      ["denied", "Denied"],
      ["past", "Past"],
      ["intro_warm", "Warm intros"],
      ["intro_cold", "Cold intros"],
    ];
    b.innerHTML = `<div class="ssec">Filter events</div><div class="schips" id="logchips">${kinds.map(([k, l]) => `<button class="schip ${S.logf === k ? "on" : ""}" data-lf="${k}">${l}</button>`).join("")}</div>`;
    b.querySelector("#logchips").onclick = (e) => {
      const x = e.target.closest("[data-lf]");
      if (!x) return;
      S.logf = x.dataset.lf;
      b.querySelectorAll("#logchips .schip").forEach((c) => c.classList.toggle("on", c === x));
      renderLog();
    };
  } else if (S.view === "map") {
    b.innerHTML =
      `<div class="ssec">Tie strength</div>` +
      [
        ["Strong tie", "var(--green)"],
        ["Medium tie", "var(--amber)"],
        ["Weak tie", "var(--slate)"],
      ]
        .map(
          ([l, c]) =>
            `<div style="display:flex;align-items:center;gap:9px;padding:5px 0;font-size:12.5px;color:#b9cabf"><span style="width:18px;height:3px;border-radius:2px;background:${c}"></span>${l}</div>`,
        )
        .join("") +
      `<div class="side-help">You → connections → investor. Dashed = no warm path yet.</div>`;
  } else if (S.view === "contacts") {
    b.innerHTML =
      `<div class="ssec">Intro status</div>` +
      CONNSTATUS.map(
        ([k, l]) =>
          `<div style="display:flex;align-items:center;gap:9px;padding:5px 0;font-size:12.5px;color:#b9cabf"><span style="width:9px;height:9px;border-radius:50%;background:${CSTAT[k].c}"></span>${l}</div>`,
      ).join("") +
      `<div class="side-help">Add a person as a connection on any investor. Set <b>Promised</b> when they agree — they show as owing you.</div>`;
  } else if (S.view === "round") {
    b.innerHTML = `<div class="side-help">Pipeline deals fill the bar toward target by stage. Suggestions cover the gap — <b>+ Add</b> sends one to the pipeline. <b>◆</b> marks the odds-weighted expected close.</div>`;
  } else if (S.view === "deck") {
    b.innerHTML = `<div class="side-help">Eight dimensions a seed partner weighs, scored 0–5 and weighted for your stage, weakest first. The <b>Fix</b> under each is the fastest way to move the number.</div>`;
  } else {
    b.innerHTML =
      `<div class="ssec">The cycle</div>` +
      FLOW.concat("denied", "past")
        .map(
          (s) =>
            `<div style="display:flex;align-items:center;gap:9px;padding:5px 0;font-size:12.5px;color:#b9cabf"><span style="width:9px;height:9px;border-radius:50%;background:${STAGE[s].color}"></span>${STAGE[s].label}</div>`,
        )
        .join("");
  }
}
