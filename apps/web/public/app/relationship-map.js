// ---- relationship map (SVG: You → connections → investor) ----
const trunc = (s, n) => {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
function nodeRect(x, y, w, h, t1, t2, fill, stroke, textColor) {
  textColor = textColor || "var(--ink)";
  const ty = t2 ? y + h / 2 - 2 : y + h / 2 + 4;
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" style="fill:${fill};stroke:${stroke};stroke-width:1.2"/>` +
    `<text x="${x + w / 2}" y="${ty}" text-anchor="middle" font-size="11" style="fill:${textColor};font-weight:650">${esc(t1)}</text>` +
    (t2
      ? `<text x="${x + w / 2}" y="${y + h / 2 + 11}" text-anchor="middle" font-size="9" style="fill:var(--muted)">${esc(t2)}</text>`
      : "")
  );
}
function relMapSVG(v, d) {
  const p = v.best_partner || {};
  const conns = ((d && d.connections) || []).filter((c) => c);
  const named = conns.filter((c) => c.name);
  const W = 372,
    rowH = 52,
    pad = 14,
    H = Math.max((named.length || 1) * rowH + pad * 2, 92);
  const youX = 6,
    youW = 54,
    youY = H / 2,
    invW = 120,
    invX = W - invW - 6,
    invY = H / 2,
    cX = youX + youW + 30,
    cW = 132;
  const sCol = { strong: "var(--green)", medium: "var(--amber)", weak: "var(--slate)" },
    sW = { strong: 2.6, medium: 1.8, weak: 1.1 };
  let edges = "",
    nodes = "";
  if (!named.length) {
    edges += `<path d="M ${youX + youW} ${youY} C ${(youX + youW + invX) / 2} ${youY}, ${(youX + youW + invX) / 2} ${invY}, ${invX} ${invY}" style="fill:none;stroke:var(--muted);stroke-width:1.4;stroke-dasharray:5 4"/>`;
    edges += `<text x="${(youX + youW + invX) / 2}" y="${youY - 9}" text-anchor="middle" font-size="10" style="fill:var(--muted)">no warm path yet — cold outreach</text>`;
  } else {
    named.forEach((c, i) => {
      const cy = pad + rowH * i + rowH / 2,
        col = sCol[c.strength] || sCol.medium,
        w = sW[c.strength] || 1.8;
      edges += `<path d="M ${youX + youW} ${youY} C ${cX - 16} ${youY}, ${cX - 16} ${cy}, ${cX} ${cy}" style="fill:none;stroke:var(--line);stroke-width:1.4"/>`;
      edges += `<path d="M ${cX + cW} ${cy} C ${invX - 16} ${cy}, ${invX - 16} ${invY}, ${invX} ${invY}" style="fill:none;stroke:${col};stroke-width:${w}"/>`;
      nodes += nodeRect(
        cX,
        cy - 16,
        cW,
        32,
        trunc(c.name, 18),
        trunc(c.relation || "", 22),
        "var(--surface)",
        "var(--line)",
      );
      nodes += `<circle cx="${cX + cW - 9}" cy="${cy - 9}" r="3.5" style="fill:${col}"><title>${esc(c.strength || "medium")} tie</title></circle>`;
    });
  }
  nodes += nodeRect(youX, youY - 15, youW, 30, "You", "", "var(--brand-d)", "transparent", "#fff");
  nodes += nodeRect(
    invX,
    invY - 18,
    invW,
    36,
    trunc(v.firm, 17),
    trunc(p.name || "", 22),
    "var(--raise)",
    "var(--brand)",
  );
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="min-width:${W}px;display:block">${edges}${nodes}</svg>`;
}
function connRow(c, i) {
  return `<div class="conn" data-ci="${i}"><div class="cr">
  <input data-cf="name" list="contactnames" placeholder="Who can introduce you" value="${esc(c.name || "")}">
  <input data-cf="relation" placeholder="Their tie / how you know them" value="${esc(c.relation || "")}">
  <select data-cf="strength"><option value="strong"${c.strength === "strong" ? " selected" : ""}>Strong tie</option><option value="medium"${!c.strength || c.strength === "medium" ? " selected" : ""}>Medium tie</option><option value="weak"${c.strength === "weak" ? " selected" : ""}>Weak tie</option></select>
  <select data-cf="status">${CONNSTATUS.map(([k, l]) => `<option value="${k}"${(c.status || "idea") === k ? " selected" : ""}>${l}</option>`).join("")}</select>
</div><input data-cf="note" placeholder="note (optional)" value="${esc(c.note || "")}" style="width:100%;margin-top:6px">
<div style="text-align:right;margin-top:6px"><button class="rm sm" data-rmconn>Remove</button></div></div>`;
}
// unique intro contacts derived from all deal connections (reusable, with favor status)
function allContacts() {
  const m = {};
  Object.entries(CRM.deals).forEach(([id, d]) => {
    (d.connections || []).forEach((c) => {
      if (!c || !c.name) return;
      const k = c.name.trim();
      if (!m[k]) m[k] = { name: k, tie: "", links: [] };
      if (c.relation && !m[k].tie) m[k].tie = c.relation;
      m[k].links.push({
        dealId: id,
        firm: vc(id)?.firm || id,
        strength: c.strength || "medium",
        status: c.status || "idea",
        note: c.note || "",
      });
    });
  });
  return m;
}
