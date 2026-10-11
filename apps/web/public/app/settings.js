// ---- model settings (admin only) ----
//
// Which provider, base URL, model and key this deploy uses. The key is
// write-only: the server returns its last four characters, never the key.
let PROVIDER_INFO = {};

function describeProvider(name) {
  const p = PROVIDER_INFO[name] || {};
  const caps = p.capabilities || {};
  const missing = [
    !caps.webSearch && "finding new investors (needs web search)",
    !caps.webFetch && "following links from your website (the landing page is still read)",
  ].filter(Boolean);
  document.getElementById("set-caps").textContent = missing.length
    ? `Not available with this provider: ${missing.join("; ")}.`
    : "Everything in the app works with this provider.";
  document.getElementById("set-base").placeholder = p.baseUrl || "";
  document.getElementById("set-model").placeholder = p.model || "required";
}

function openSettings() {
  fetch("/api/settings")
    .then((r) => r.json())
    .then((j) => {
      if (j.error) return toast(j.error);
      PROVIDER_INFO = j.providers || {};
      document.getElementById("set-provider").innerHTML = Object.entries(PROVIDER_INFO)
        .map(([name, p]) => `<option value="${esc(name)}">${esc(p.label || name)}</option>`)
        .join("");
      const status = j.ready
        ? `Using <b>${esc(j.model)}</b> via ${esc(j.provider)}` +
          (j.keySet ? `, key …${esc(j.keyTail)} (from ${esc(j.keySource)})` : ", no key")
        : `<b style="color:var(--amber)">The AI model is not set up.</b> Nothing that calls the model will work until it is.`;
      document.getElementById("set-src").innerHTML = status;
      const isDefault = j.baseUrl === (PROVIDER_INFO[j.provider] || {}).baseUrl;
      document.getElementById("set-provider").value = j.provider;
      document.getElementById("set-base").value = isDefault ? "" : j.baseUrl;
      document.getElementById("set-key").value = "";
      document.getElementById("set-model").value = j.model || "";
      document.getElementById("set-effort").value = j.effort || "high";
      describeProvider(j.provider);
      document.getElementById("setbg").classList.add("on");
    });
}

function closeSettings() {
  document.getElementById("setbg").classList.remove("on");
}

async function saveSettings() {
  const key = document.getElementById("set-key").value.trim();
  const body = {
    provider: document.getElementById("set-provider").value,
    base_url: document.getElementById("set-base").value.trim(),
    model: document.getElementById("set-model").value.trim(),
    effort: document.getElementById("set-effort").value,
  };
  // An empty box means "leave the key alone"; "clear" removes a saved one.
  if (key) body.api_key = key.toLowerCase() === "clear" ? "" : key;
  const r = await fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return toast(j.error || "Could not save");
  toast(j.ready ? "Saved" : "Saved, but the model is not fully set up yet");
  closeSettings();
  AI_READY = j.ready;
  renderStats();
}

document.getElementById("set-provider").onchange = (e) => {
  describeProvider(e.target.value);
  // A model name from one provider is meaningless to another.
  document.getElementById("set-model").value = "";
};
