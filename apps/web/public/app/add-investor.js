// ---- add investor ----
async function reloadData() {
  const d = await fetch("/api/data").then((r) => r.json());
  VCS = d.vcs || [];
  KEY = d.keyPresent;
  COMPS = d.competitors || [];
  Object.keys(byId).forEach((k) => delete byId[k]);
  VCS.forEach((v) => {
    v.id = v.id || v.firm.toLowerCase().replace(/[^a-z0-9]+/g, "");
    byId[v.id] = v;
  });
  refresh();
}
function openAddModal() {
  document.getElementById("addmodal-bg").classList.add("on");
  document.getElementById("ai-firm").focus();
}
function closeAddModal() {
  document.getElementById("addmodal-bg").classList.remove("on");
}
document.getElementById("addmodal-bg").addEventListener("click", (e) => {
  if (e.target.id === "addmodal-bg") closeAddModal();
});
document.getElementById("ai-save").onclick = async () => {
  const g = (id) => document.getElementById(id).value.trim();
  const firm = g("ai-firm");
  if (!firm) {
    toast("Name is required");
    return;
  }
  const body = {
    firm,
    type: g("ai-type"),
    hq: g("ai-hq"),
    check_size: g("ai-check"),
    category: g("ai-cat"),
    fit_score: g("ai-fit"),
    best_partner: { name: g("ai-partner"), email: g("ai-email") },
    website: g("ai-web"),
    thesis: g("ai-thesis"),
    leads_rounds: document.getElementById("ai-leads").checked,
  };
  const btn = document.getElementById("ai-save");
  btn.disabled = true;
  try {
    const r = await fetch("/api/investor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.error) {
      toast("Error: " + j.error);
    } else {
      await reloadData();
      closeAddModal();
      toast(firm + " added to directory");
      ["ai-firm", "ai-hq", "ai-check", "ai-cat", "ai-partner", "ai-email", "ai-web", "ai-thesis"].forEach(
        (id) => (document.getElementById(id).value = ""),
      );
      document.getElementById("ai-fit").value = "75";
      document.getElementById("ai-leads").checked = false;
      if (j.investor && j.investor.id) openDrawer(j.investor.id);
    }
  } catch (e) {
    toast("Error: " + e.message);
  }
  btn.disabled = false;
};
