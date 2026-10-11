// ---- model settings (admin only) ----
//
// The key is write-only across this boundary: GET returns whether one is set
// and its last four characters, never the key. Nothing here ever holds it.
function openSettings() {
  fetch("/api/settings")
    .then((r) => r.json())
    .then((j) => {
      if (j.error) {
        toast(j.error);
        return;
      }
      document.getElementById("set-src").innerHTML = j.keySet
        ? `Key in use: <b>…${esc(j.keyTail)}</b> (from ${esc(j.keySource)})`
        : `<b style="color:var(--amber)">No API key configured.</b> Nothing that calls the model will work until one is set.`;
      document.getElementById("set-key").value = "";
      document.getElementById("set-model").value = j.model || "";
      document.getElementById("set-effort").value = j.effort || "high";
      document.getElementById("setbg").classList.add("on");
    });
}
function closeSettings() {
  document.getElementById("setbg").classList.remove("on");
}
async function saveSettings() {
  const key = document.getElementById("set-key").value.trim();
  const body = {
    model: document.getElementById("set-model").value.trim(),
    effort: document.getElementById("set-effort").value,
  };
  // "clear" is the explicit way to remove a saved key: an empty box has to mean
  // "leave it alone", or every save of an unrelated field would wipe the key.
  if (key) body.api_key = key.toLowerCase() === "clear" ? "" : key;
  const r = await fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    toast(j.error || "Could not save");
    return;
  }
  toast("Saved");
  closeSettings();
  const d = await fetch("/api/data")
    .then((r) => r.json())
    .catch(() => null);
  if (d) KEY = d.keyPresent;
}
