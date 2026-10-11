#!/usr/bin/env node
// Load the bundled investor list into a company's pipeline.
//
//   node scripts/seed-investors.js <company_id> [out-dir]
//   npx wrangler d1 execute fundraise-crm-db --remote --file=<out-dir>/001.sql   (per chunk)
//
// Emits SQL rather than talking to D1 itself, for the same reason seed-user.js
// does: the script needs no credentials, the output is reviewable before it
// touches a database, and the same file works against --local and --remote.
//
// Chunked because a single 900-row file is a single failure. Each chunk is
// independently applicable and re-applicable — the INSERT upserts on
// (company_id, id), so re-running one repairs it rather than duplicating it.
//
// Rows land with source='seed' and scored=false. They are facts about firms
// with no opinion attached; the fit numbers come from "Score against my deck"
// in the app, which scores them against the profile read from YOUR material.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [, , companyId, outDir = "seed-sql"] = process.argv;
if (!companyId || !/^co_[a-z0-9]+$/i.test(companyId)) {
  console.error("usage: node scripts/seed-investors.js <company_id> [out-dir]");
  console.error("  company_id looks like co_ab12cd34ef — scripts/seed-user.js prints it.");
  process.exit(1);
}

const SRC = path.join(__dirname, "../../../data/investors.json");
if (!fs.existsSync(SRC)) {
  console.error(`No investor list at ${SRC}. Nothing to seed.`);
  process.exit(1);
}

const investors = JSON.parse(fs.readFileSync(SRC, "utf8"));
const now = Date.now();
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// 100 rows per file: comfortably inside what `d1 execute --file` handles in one
// go, and small enough that a failure is cheap to re-run.
const CHUNK = 100;
const files = [];
for (let i = 0; i < investors.length; i += CHUNK) {
  const rows = investors
    .slice(i, i + CHUNK)
    .map(
      (v) =>
        `INSERT INTO investors (id, company_id, data, source, updated_by, updated_at) VALUES (` +
        `${q(v.id)}, ${q(companyId)}, ${q(JSON.stringify(v))}, 'seed', 'seed', ${now}) ` +
        `ON CONFLICT(company_id, id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at;`,
    );
  const name = path.join(outDir, String(files.length + 1).padStart(3, "0") + ".sql");
  // D1 wraps a --file itself and rejects an explicit BEGIN/COMMIT inside one.
  fs.writeFileSync(name, rows.join("\n") + "\n");
  files.push(name);
}

console.error(`${investors.length} investors -> ${files.length} files in ${outDir}/`);
console.error("Apply each with:");
console.error(
  `  for f in ${outDir}/*.sql; do npx wrangler d1 execute fundraise-crm-db --remote --file="$f"; done`,
);
