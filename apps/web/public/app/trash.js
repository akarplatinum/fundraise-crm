// ---- trash ----
function renderTrash() {
  const items = (CRM.trash || []).map((id) => vc(id)).filter(Boolean);
  const mb = document.getElementById("mbody");
  if (!items.length) {
    mb.innerHTML = `<div class="empty">Trash is empty. Remove an investor with Trash on any Directory row. Nothing is deleted for good — restore anytime.</div>`;
    return;
  }
  let html = `<div class="counted">${items.length} in trash · hidden from the Directory, restore anytime</div><div class="tablewrap"><table><thead><tr><th>Fit</th><th>Firm</th><th>Type</th><th></th></tr></thead><tbody>`;
  html += items
    .map(
      (v) =>
        `<tr><td><div class="sc" style="background:${scoreColor(v.fit_score)}">${v.fit_score}</div></td><td class="fcell"><b>${esc(v.firm)}</b><div class="fx">${esc(v.hq || "")}${v.check_size && v.check_size !== "unknown" ? " · " + esc(v.check_size) : ""}</div></td><td class="typ">${esc(v.type)}</td><td><button class="btn sm" data-restore="${v.id}">↩ Restore</button></td></tr>`,
    )
    .join("");
  html += `</tbody></table></div>`;
  mb.innerHTML = html;
  mb.querySelectorAll("[data-restore]").forEach(
    (b) => (b.onclick = () => restoreInvestor(b.dataset.restore)),
  );
}

// ---- trash ----
const isTrashed = (id) => !!(CRM.trash && CRM.trash.includes(id));
function trashInvestor(id) {
  if (!CRM.trash) CRM.trash = [];
  if (!CRM.trash.includes(id)) CRM.trash.push(id);
  save();
  toast((vc(id)?.firm || "Investor") + " moved to trash");
  if (drawerId === id) closeDrawer();
  refresh();
}
function restoreInvestor(id) {
  CRM.trash = (CRM.trash || []).filter((x) => x !== id);
  save();
  toast((vc(id)?.firm || "Investor") + " restored");
  refresh();
}
