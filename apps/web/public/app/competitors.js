// ---- competitors ----
// The companies your own deck or site names as competitors or comparables.
// They come from deck analysis (profile.competitors), so this view is only as
// complete as the material you gave it.
function renderCompetitors() {
  const mb = document.getElementById("mbody");
  const comps = (COMPS || []).filter((c) => c && c.name);
  if (!comps.length) {
    mb.innerHTML = `<div class="empty">No competitors yet. They are read from your deck or website, so name the ones investors will ask about there and re-run the analysis.</div>`;
    return;
  }
  mb.innerHTML = comps
    .map(
      (c) =>
        `<div class="mapcard"><div class="mt">${esc(c.name)}</div>${c.note ? `<div class="mnote">${esc(c.note)}</div>` : ""}</div>`,
    )
    .join("");
}
