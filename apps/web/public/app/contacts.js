// ---- intro manager (contacts) ----
// parse "Name (Firm)" → {person, org}; groups intro contacts by their firm
function parseOrg(name) {
  const m = String(name || "").match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  return m ? { person: m[1].trim(), org: m[2].trim() } : { person: String(name || "").trim(), org: "" };
}
function renderContacts() {
  const contacts = Object.values(allContacts());
  const mb = document.getElementById("mbody");
  if (!contacts.length) {
    mb.innerHTML = `<div class="empty">No intro contacts yet. Open any investor and add a <b>connection</b> — the person who can introduce you. They collect here, reusable across deals, with who-owes-whom tracked. Tip: name them <b>Person (Firm)</b> to group contacts by firm.</div>`;
    return;
  }
  const allLinks = contacts.flatMap((c) => c.links);
  const cnt = (st) => allLinks.filter((l) => l.status === st).length;
  let html = `<div class="rbstat" style="margin-bottom:16px">
    <div><div class="n">${contacts.length}</div><div class="l">contacts</div></div>
    <div><div class="n" style="color:var(--cyan)">${cnt("promised")}</div><div class="l">intros owed to you</div></div>
    <div><div class="n" style="color:var(--pink)">${cnt("repay")}</div><div class="l">you owe back</div></div>
    <div><div class="n" style="color:var(--green)">${cnt("done")}</div><div class="l">intros made</div></div></div>`;
  // group by org parsed from the name
  const groups = {};
  contacts.forEach((c) => {
    const { person, org } = parseOrg(c.name);
    const key = org ? "org:" + org.toLowerCase() : "solo:" + c.name;
    (groups[key] = groups[key] || { org, items: [] }).items.push({ ...c, _person: person });
  });
  const linkRow = (l, person) =>
    `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--line)"><span class="roletag" style="background:${CSTAT[l.status].c};color:#fff">${CSTAT[l.status].l}</span>${person ? `<span style="color:var(--muted);font-size:11px">${esc(person)} →</span>` : ""}<b data-open="${l.dealId}" style="cursor:pointer">${esc(l.firm)}</b><span style="color:var(--muted);font-size:11px">${esc(l.strength)} tie${l.note ? " · " + esc(l.note) : ""}</span></div>`;
  const owedIn = (links) => links.filter((l) => l.status === "promised").length;
  html += Object.values(groups)
    .sort((a, b) => {
      const al = a.items.flatMap((c) => c.links),
        bl = b.items.flatMap((c) => c.links);
      return owedIn(bl) - owedIn(al) || bl.length - al.length;
    })
    .map((g) => {
      if (g.org) {
        const links = g.items.flatMap((c) => c.links.map((l) => ({ l, person: c._person })));
        const o = owedIn(g.items.flatMap((c) => c.links));
        return `<div class="mapcard"><div class="mt">${esc(g.org)}<span class="mtag">${g.items.length} contact${g.items.length !== 1 ? "s" : ""} · ${links.length} intro${links.length !== 1 ? "s" : ""}</span>${o ? `<span class="roletag" style="background:var(--cyan);color:#fff;margin-left:auto">owes you ${o}</span>` : ""}</div>${links.map(({ l, person }) => linkRow(l, person)).join("")}</div>`;
      }
      const c = g.items[0];
      const o = owedIn(c.links);
      return `<div class="mapcard"><div class="mt">${esc(c._person || c.name)}${c.tie ? `<span class="mtag">${esc(c.tie)}</span>` : ""}${o ? `<span class="roletag" style="background:var(--cyan);color:#fff;margin-left:auto">owes you ${o}</span>` : `<span style="margin-left:auto;color:var(--muted);font-size:12px">${c.links.length} intro${c.links.length !== 1 ? "s" : ""}</span>`}</div>${c.links.map((l) => linkRow(l, null)).join("")}</div>`;
    })
    .join("");
  mb.innerHTML = html;
  mb.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => openDrawer(b.dataset.open)));
}
