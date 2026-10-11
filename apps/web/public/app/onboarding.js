const $ = (id) => document.getElementById(id);
let company = null;

// Motion, same restraint as the CRM: this fires once, right after an analysis
// the founder waited a minute for, so the reveal is worth animating. No-ops
// under prefers-reduced-motion or if the vendored script is missing.
const MO = window.Motion || {};
const REDUCE = !MO.animate || matchMedia("(prefers-reduced-motion:reduce)").matches;
function fx(el, kf, o) {
  if (REDUCE || !el) return null;
  try {
    return MO.animate(el, kf, o);
  } catch (_) {
    return null;
  }
}
function reveal(el, delay) {
  fx(
    el,
    { opacity: [0, 1], transform: ["translateY(10px)", "none"] },
    { duration: 0.26, delay, easing: "ease-out" },
  );
}

const esc = (s) =>
  String(s == null ? "" : s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

function note(el, text, cls) {
  el.className = "msg" + (cls ? " " + cls : "");
  el.innerHTML = text;
}

// ---- step 1: deck and/or website ----
//
// A file is held rather than uploaded on selection, so a founder who has both a
// deck and a site gets one analysis over the pair instead of two runs that
// overwrite each other (and burn two quota units).
let picked = null;

$("drop").onclick = () => $("file").click();
["dragenter", "dragover"].forEach((e) =>
  $("drop").addEventListener(e, (ev) => {
    ev.preventDefault();
    $("drop").classList.add("over");
  }),
);
["dragleave", "drop"].forEach((e) =>
  $("drop").addEventListener(e, (ev) => {
    ev.preventDefault();
    $("drop").classList.remove("over");
  }),
);
$("drop").addEventListener("drop", (ev) => ev.dataTransfer.files[0] && choose(ev.dataTransfer.files[0]));
$("file").onchange = () => $("file").files[0] && choose($("file").files[0]);

function choose(f) {
  if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf")
    return note($("m1"), "That needs to be a PDF.", "err");
  if (f.size > 20 * 1024 * 1024) return note($("m1"), "That file is over 20MB.", "err");
  picked = f;
  note(
    $("m1"),
    `<span class="picked">${esc(f.name)} <button class="ghost" id="clear">Remove</button></span>`,
  );
  $("clear").onclick = () => {
    picked = null;
    $("file").value = "";
    note($("m1"), "");
  };
}

$("site").onkeydown = (e) => e.key === "Enter" && $("analyze").click();

$("analyze").onclick = async () => {
  const site = $("site").value.trim();
  if (!picked && !site) return note($("m1"), "Add a deck, a website, or both.", "err");

  $("analyze").disabled = true;
  const what = picked && site ? "your deck and site" : picked ? "your deck" : "your site";
  note($("m1"), `<span class="spin"></span>Analyzing ${esc(what)}. This takes up to a minute.`);
  try {
    if (picked) {
      // Raw bytes, not multipart — the server only wants the PDF itself.
      const q =
        "/api/deck?name=" +
        encodeURIComponent(picked.name) +
        (site ? "&url=" + encodeURIComponent(site) : "");
      await api(q, { method: "POST", headers: { "content-type": "application/pdf" }, body: picked });
    } else {
      await api("/api/site", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: site }),
      });
    }
    poll();
  } catch (e) {
    $("analyze").disabled = false;
    note($("m1"), esc(e.message), "err");
  }
};

// Analysis runs server-side after the upload returns, so poll for the result.
async function poll() {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    let me;
    try {
      me = await api("/api/me");
    } catch (_) {
      continue;
    }
    const st = me.company?.deck?.status;
    if (st === "ready") {
      company = me.company;
      return render();
    }
    if (st === "failed") {
      $("analyze").disabled = false;
      return note($("m1"), esc(me.company.deck.error || "Analysis failed."), "err");
    }
  }
  $("analyze").disabled = false;
  note($("m1"), "Still working. Reload in a moment to check.", "err");
}

// ---- steps 2 + 3 ----
function render() {
  const p = company.profile || {};
  note($("m1"), "Analysis complete.", "ok");
  $("s1").classList.add("done");
  $("analyze").disabled = false;

  const rows = [
    ["Company", p.company],
    ["What it does", p.one_liner],
    ["Website", company.siteUrl],
    ["Stage", p.stage],
    ["Raising", p.raising],
    ["Model", p.business_model],
  ].filter(([, v]) => v);

  $("prof").innerHTML =
    rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("") +
    (p.traction?.length
      ? `<dt>Traction</dt><dd><ul class="t">${p.traction.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></dd>`
      : "");

  // Surfacing gaps is deliberate: these are the questions a partner will ask,
  // and it's better the founder sees them here than in a first meeting.
  if (p.gaps?.length) {
    $("gaps").hidden = false;
    $("gaps").innerHTML =
      "<strong>Your deck doesn't answer these yet</strong>" +
      `<ul class="t">${p.gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>`;
  }

  // A critique already written for this company survives a reload — it costs an
  // API call, so it is stored on the profile rather than regenerated on view.
  if (p.critique) showCritique(p.critique, p.critique_ts);

  // The score is shown before the chips on purpose: the founder should see how
  // the deck reads before being asked to confirm where to send it.
  const sc = p.deck_score;
  if (sc) {
    $("score").hidden = false;
    $("score").innerHTML =
      `<div class="top"><span class="num">${esc(sc.overall)}<span> / 5</span></span>` +
      `<span class="band">${esc(sc.band)}</span></div>` +
      `<div class="basis">Scored against what's normal at ${esc(sc.stage_basis.replace("-", " "))}. ` +
      `Weakest first.</div>` +
      sc.dimensions
        .map(
          (d) =>
            `<div class="dim${d.score <= 2 ? " low" : ""}">` +
            `<span class="nm">${esc(d.label)}</span>` +
            `<span class="bar"><i style="width:${(d.score / 5) * 100}%"></i></span>` +
            `<span class="fix">${esc(d.score <= 2 && d.fix ? d.fix : d.evidence)}</span></div>`,
        )
        .join("");
  }

  // Confirmed selection wins; otherwise the analyzer's labels. Either list can
  // hold bare strings (older profiles, hand-added chips) or taxonomy objects.
  const cats = company.categories?.length ? company.categories : p.categories || [];
  const custom = company.categories?.length ? [] : p.custom_tags || [];
  $("chips").innerHTML = cats
    .map((c) => {
      const label = typeof c === "string" ? c : c.label;
      // Low-confidence labels start off: the founder opts them in rather than
      // out, so an inferred tag never silently steers the investor search.
      const conf = typeof c === "string" ? 1 : c.confidence;
      const on = conf >= 0.5 ? " on" : "";
      const pct = typeof c === "string" ? "" : `<span class="cf">${Math.round(conf * 100)}%</span>`;
      const why = typeof c === "string" ? "" : ` title="${esc(c.evidence)}"`;
      // data-label, not textContent: the chip renders a confidence badge too,
      // and reading textContent on submit would send "b2b-saas92%".
      return `<span class="chip${on}" data-label="${esc(label)}"${why}>${esc(label)}${pct}</span>`;
    })
    .concat(custom.map((t) => `<span class="chip on" data-label="${esc(t)}">${esc(t)}</span>`))
    .join("");
  $("s2").hidden = false;
  $("s3").hidden = false;
  reveal($("s2"), 0.04);
  reveal($("s3"), 0.12);
  // Bars grow from zero rather than appearing at length: the point of the score
  // is which dimensions came up short, and a bar that stops early reads that
  // way far more sharply than one that was always that length.
  [...$("score").querySelectorAll(".bar i")].forEach((b, i) =>
    fx(b, { width: ["0%", b.style.width] }, { duration: 0.5, delay: 0.18 + i * 0.05, easing: "ease-out" }),
  );
  [...$("chips").children]
    .slice(0, 20)
    .forEach((c, i) =>
      fx(
        c,
        { opacity: [0, 1], transform: ["scale(.94)", "none"] },
        { duration: 0.18, delay: 0.2 + i * 0.024, easing: "ease-out" },
      ),
    );
}

// closest(), not e.target: a click can land on the confidence badge inside the
// chip, which is not itself a .chip.
$("chips").onclick = (e) => e.target.closest(".chip")?.classList.toggle("on");

$("addcat").onclick = () => {
  const v = $("newcat").value.trim();
  if (!v) return;
  $("chips").insertAdjacentHTML("beforeend", `<span class="chip on" data-label="${esc(v)}">${esc(v)}</span>`);
  $("newcat").value = "";
};
$("newcat").onkeydown = (e) => e.key === "Enter" && $("addcat").click();

// Escape first, then promote headings. Doing it in that order means the model
// can put a literal "<" in a rewrite suggestion without it becoming markup.
function showCritique(text, ts) {
  const html = esc(text)
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^\s*[-*] (.+)$/gm, "• $1");
  const when = ts ? `<div class="when">Written ${new Date(ts).toLocaleDateString()}</div>` : "";
  $("crit").innerHTML = html + when;
  $("crit").hidden = false;
  $("critbtn").textContent = "Rewrite the critique";
}

$("critbtn").onclick = async () => {
  const b = $("critbtn");
  const label = b.textContent;
  b.disabled = true;
  b.textContent = "Reading the deck like an investor…";
  try {
    const r = await fetch("/api/critique", { method: "POST" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not write a critique.");
    showCritique(d.text, d.ts);
  } catch (e) {
    note($("m1"), e.message, true);
    b.textContent = label;
  } finally {
    b.disabled = false;
  }
};

$("redo").onclick = () => {
  $("s2").hidden = $("s3").hidden = $("score").hidden = true;
  $("s1").classList.remove("done");
  picked = null;
  $("file").value = "";
  note($("m1"), "");
};

// The stage line is descriptive, not a progress bar. Discovery gives no
// milestones to report, and a bar that fills against an unknown duration lies.
// These name what the search is actually doing, in the order it does it.
const STAGES = [
  "Searching for funds active in your categories",
  "Reading fund sites and recent investments",
  "Checking which partners lead at your stage",
  "Looking for relevant portfolio overlap",
  "Verifying every firm against a real source",
  "Scoring fit against your deck",
  "Still going — thorough beats fast here",
];
let loaderTimer = null;

function showLoader(startedAt) {
  const t0 = startedAt || Date.now();
  $("loader").hidden = false;
  fx($("loader"), { opacity: [0, 1] }, { duration: 0.22 });
  clearInterval(loaderTimer);
  const tick = () => {
    const s = Math.floor((Date.now() - t0) / 1000);
    $("elapsed").textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    // Advance roughly every 45s, then hold on the last line rather than looping
    // back to "searching" — a line that repeats reads as a stuck process.
    const line = STAGES[Math.min(Math.floor(s / 45), STAGES.length - 1)];
    if ($("stage").textContent !== line) {
      $("stage").textContent = line;
      fx($("stage"), { opacity: [0, 1], transform: ["translateY(4px)", "none"] }, { duration: 0.3 });
    }
  };
  tick();
  loaderTimer = setInterval(tick, 1000);
}

function hideLoader() {
  clearInterval(loaderTimer);
  $("loader").hidden = true;
}

// Discovery runs server-side in the background, so this survives a reload or a
// closed tab — the status lives on the company row, not in this page.
async function pollDiscovery() {
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    let me;
    try {
      me = await api("/api/me");
    } catch (_) {
      continue; // transient — the search is still running server-side
    }
    const d = me.company?.discover || {};
    if (d.status === "ready") {
      if (!d.found) {
        hideLoader();
        $("go").disabled = false;
        return note($("m3"), "No new investors came back. Try different categories.", "err");
      }
      $("stage").textContent = `Found ${d.found}. Opening your pipeline…`;
      return setTimeout(() => (location.href = "/"), 900);
    }
    if (d.status === "failed") {
      hideLoader();
      $("go").disabled = false;
      return note($("m3"), esc(d.error || "The search failed."), "err");
    }
  }
}

$("go").onclick = async () => {
  const picked = [...document.querySelectorAll(".chip.on")].map((c) => c.dataset.label);
  if (!picked.length) return note($("m3"), "Pick at least one category.", "err");
  $("go").disabled = true;
  note($("m3"), "");
  try {
    await api("/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ categories: picked }),
    });
    await api("/api/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ categories: picked }),
    });
    showLoader();
    pollDiscovery();
  } catch (e) {
    $("go").disabled = false;
    note($("m3"), esc(e.message), "err");
  }
};

// A founder who already ran an analysis lands straight on steps 2-3.
api("/api/me")
  .then((me) => {
    // Single-tenant deploys turn deck upload off; the profile is curated
    // directly and re-analysis would only clobber it. Hide the upload step and
    // the "start over" reset so there's no path back to it. render() still runs
    // for steps 2-3 (profile, critique, categories).
    if (me.deckUpload === false) {
      $("s1").hidden = true;
      $("redo").hidden = true;
    }
    if (me.company?.siteUrl) $("site").value = me.company.siteUrl;
    // A search already in flight (reload, or they closed the tab and came back)
    // picks the loading screen straight back up. Elapsed restarts from zero —
    // the true start isn't stored, and inventing one would be a worse lie than
    // a timer that undercounts.
    if (me.company?.discover?.status === "searching") {
      company = me.company;
      render();
      $("go").disabled = true;
      showLoader();
      pollDiscovery();
      return;
    }
    if (me.company?.deck?.status === "ready") {
      company = me.company;
      render();
    } else if (me.company?.deck?.status === "analyzing") {
      $("analyze").disabled = true;
      note($("m1"), '<span class="spin"></span>Still analyzing…');
      poll();
    }
  })
  .catch(() => {});
