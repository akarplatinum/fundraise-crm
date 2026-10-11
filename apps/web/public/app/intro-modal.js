// ---- intro modal ----
function openModal(v) {
  modalCtx = v;
  modalType = "warm";
  const p = v.best_partner || {};
  document.getElementById("m-firm").textContent = v.firm;
  document.getElementById("m-partner").textContent =
    (p.name || "the partner") + (p.title ? " · " + p.title : "");
  document.getElementById("m-notes").value = "";
  document.getElementById("m-out").style.display = "none";
  document.getElementById("m-actions").style.display = "none";
  document.getElementById("m-send").hidden = true;
  document.querySelectorAll("#m-seg button").forEach((b) => b.classList.toggle("on", b.dataset.t === "warm"));
  document.getElementById("modalbg").classList.add("on");
}
function closeModal() {
  document.getElementById("modalbg").classList.remove("on");
}
document.querySelectorAll("#m-seg button").forEach(
  (b) =>
    (b.onclick = () => {
      modalType = b.dataset.t;
      document.querySelectorAll("#m-seg button").forEach((x) => x.classList.toggle("on", x === b));
    }),
);
document.getElementById("modalbg").addEventListener("click", (e) => {
  if (e.target.id === "modalbg") closeModal();
});
async function genIntro() {
  if (!AI_READY) {
    toast("Drafting needs the AI model set up. An admin can do it in Model settings.");
    return;
  }
  const v = modalCtx,
    p = v.best_partner || {};
  const out = document.getElementById("m-out"),
    gen = document.getElementById("m-gen");
  out.style.display = "block";
  out.innerHTML = '<span class="spin"></span> Generating…';
  document.getElementById("m-actions").style.display = "none";
  gen.disabled = true;
  try {
    const r = await fetch("/api/intro", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        firm: v.firm,
        partner: p.name,
        type: modalType,
        category: (v.category || []).join(", "),
        thesis: v.thesis,
        why: v.fit_rationale || p.why_this_partner,
        notes: document.getElementById("m-notes").value,
      }),
    });
    const j = await r.json();
    if (j.error) out.textContent = "Error: " + j.error;
    else {
      out.textContent = j.text;
      document.getElementById("m-actions").style.display = "flex";
      logEv(v.id, modalType === "warm" ? "intro_warm" : "intro_cold", p.name ? "→ " + p.name : "");
      save();
      renderSideCounts();
      renderStats();
    }
  } catch (e) {
    out.textContent = "Error: " + e.message;
  }
  gen.disabled = false;
}
document.getElementById("m-gen").onclick = genIntro;
document.getElementById("m-regen").onclick = genIntro;
document.getElementById("m-copy").onclick = () => {
  navigator.clipboard.writeText(document.getElementById("m-out").textContent);
  toast("Copied");
};
document.getElementById("m-sent").onclick = () => {
  navigator.clipboard.writeText(document.getElementById("m-out").textContent);
  const v = modalCtx;
  if (!deal(v.id) || deal(v.id)._noteonly) submit(v.id);
  const d = deal(v.id);
  if (d.stage === "submitted") advance(v.id);
  toast("Copied · " + v.firm + " → Intro sent");
  closeModal();
  refresh();
};
