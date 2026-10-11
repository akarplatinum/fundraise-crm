// ---- deal ops ----
function refresh() {
  renderStats();
  renderSideCounts();
  if (S.view === "dir") renderDir();
  if (S.view === "pipe") flipCards(renderPipe);
  if (S.view === "map") renderMap();
  if (S.view === "contacts") renderContacts();
  if (S.view === "round") renderRound();
  if (S.view === "competitors") renderCompetitors();
  if (S.view === "trash") renderTrash();
  if (S.view === "outbox") renderOutbox();
  if (S.view === "log") renderLog();
  if (drawerId) fillDrawer(drawerId);
}
function submit(id) {
  if (deal(id) && !deal(id)._noteonly) return;
  if (deal(id)?._noteonly) {
    delete deal(id)._noteonly;
    deal(id).stage = "submitted";
  } else CRM.deals[id] = { stage: "submitted", notes: "", ts: Date.now() };
  logEv(id, "submitted");
  save();
  toast(vc(id).firm + " → Submitted tab");
  refresh();
}
function advance(id) {
  const d = deal(id);
  if (!d) return;
  const i = FLOW.indexOf(d.stage);
  if (i < 0 || i >= FLOW.length - 1) return;
  const nx = FLOW[i + 1];
  d.prev = d.stage;
  d.stage = nx;
  logEv(id, nx === "signed" ? "signed" : "advance", nx === "signed" ? "" : STAGE[nx].label);
  save();
  refresh();
}
function setStage(id, st) {
  const d = deal(id);
  if (!d) return;
  d.prev = d.stage;
  d.stage = st;
  logEv(
    id,
    st === "signed" ? "signed" : st === "denied" ? "denied" : st === "past" ? "past" : "advance",
    isTerm(st) ? "" : STAGE[st].label,
  );
  save();
  refresh();
}
function pass(id) {
  setStage(id, "denied");
}
function toPast(id) {
  setStage(id, "past");
}
function reopen(id) {
  const d = deal(id);
  if (!d) return;
  d.stage = d.prev && !isTerm(d.prev) ? d.prev : "submitted";
  logEv(id, "reopen", "→ " + STAGE[d.stage].label);
  save();
  refresh();
}
function saveNow() {
  clearTimeout(st);
  push()
    .then((j) => {
      if (j) {
        markSaved();
        toast("Saved");
      }
    })
    .catch((e) => {
      console.error("save failed", e);
      markUnsaved();
      toast("Not saved: " + e.message);
    });
}
// create a lightweight (not-in-pipeline) deal record so value/connections/notes can attach before formal submit
function ensureDeal(id) {
  if (!deal(id)) CRM.deals[id] = { stage: "submitted", notes: "", ts: Date.now(), _noteonly: true };
  return deal(id);
}
function removeDeal(id) {
  if (!deal(id)) return;
  const f = vc(id)?.firm || id;
  if (
    !confirm("Remove " + f + " from the pipeline?\nThis clears its stage, notes, deal value and connections.")
  )
    return;
  delete CRM.deals[id];
  logEv(id, "removed");
  save();
  toast(f + " removed");
  closeDrawer();
  refresh();
}
function setDealValue(id, val) {
  ensureDeal(id).value = val;
  save();
}
function addConn(id) {
  const d = ensureDeal(id);
  (d.connections = d.connections || []).push({ name: "", relation: "", strength: "medium", note: "" });
  save();
  fillDrawer(id);
}
function updateConn(id, i, f, val) {
  const d = deal(id);
  if (!d || !d.connections || !d.connections[i]) return;
  d.connections[i][f] = val;
  save();
  refreshMap(id);
}
function removeConn(id, i) {
  const d = deal(id);
  if (!d || !d.connections) return;
  d.connections.splice(i, 1);
  if (!d.connections.length && d._noteonly && !d.notes && !d.value) delete CRM.deals[id];
  save();
  fillDrawer(id);
}
function refreshMap(id) {
  const el = document.getElementById("relmap");
  if (el) el.innerHTML = relMapSVG(vc(id), deal(id));
}
function toggleNeedIntro(id) {
  const d = ensureDeal(id);
  d.needIntro = !d.needIntro;
  save();
  fillDrawer(id);
}
