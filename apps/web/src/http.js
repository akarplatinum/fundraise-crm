// Response helpers.

export const JSON_TYPE = "application/json; charset=utf-8";

// Every response is per-user, so none may be cached at the edge: a cached one
// could be served to another user, or a stale 401 after a successful sign-in.
export const NO_STORE = "no-store, no-cache, must-revalidate";

export function json(body, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": JSON_TYPE, "cache-control": NO_STORE },
  });
}

// Same no-store reasoning as json(): an export is tenant data, and the edge was
// observed caching authenticated responses.
export function download(body, filename, type) {
  return new Response(body, {
    headers: {
      "content-type": type,
      "cache-control": NO_STORE,
      // Quotes + escaped quotes: a company name can legally contain one, and an
      // unquoted filename would truncate the header at the first space.
      "content-disposition": `attachment; filename="${filename.replace(/"/g, "'")}"`,
    },
  });
}

// RFC 4180: quote every field and double any embedded quote. Excel also needs a
// BOM or it mangles non-ASCII firm names, and a leading =/+/-/@ is treated as a
// formula, so those get prefixed with a quote.
export function toCsv(rows, cols) {
  const cell = (v) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [cols.map(cell).join(",")];
  for (const r of rows) lines.push(cols.map((c) => cell(r[c])).join(","));
  return "﻿" + lines.join("\r\n");
}

export async function asset(env, request, pathname) {
  const u = new URL(request.url);
  u.pathname = pathname;
  u.search = "";
  return env.ASSETS.fetch(new Request(u.toString(), { method: "GET" }));
}

// An error whose message is written for the founder. The catch-all in
// index.js passes anything carrying a status straight through to the client.
export function badRequest(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch (_) {
    throw badRequest("invalid json");
  }
}
