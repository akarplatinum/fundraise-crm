#!/usr/bin/env node
// Create a company and its first login. Prints SQL to stdout and the generated
// password to stderr, so a password never lands in a file you might commit.
//
//   node scripts/seed-user.js <username> "<Display Name>" "<Company>" [password] > /tmp/u.sql
//   npx wrangler d1 execute fundraise-crm-db --remote --file=/tmp/u.sql
//
// Omit the password and a strong one is generated. The hash must match
// worker.js hashPassword(): sha256("salt:password"), hex.
//
// Add a co-founder to an EXISTING company by passing its id as the 5th
// argument — users sharing a company_id share one pipeline:
//
//   node scripts/seed-user.js sam "Sam" "" "" co_ab12cd34ef
//
// ROLE. Whoever creates a company here is its `admin`: on a self-hosted
// instance that is you, and admin is what gates the Settings page (the model
// and the API key — the settings that spend money). Everyone added to an
// existing company, and everyone who arrives through /signup, is a `founder`:
// full use of the pipeline, no ability to repoint the deploy's billing.

import crypto from "node:crypto";

const [, , username, display, company, given, existingCompanyId] = process.argv;
if (!username || !display || (!company && !existingCompanyId)) {
  console.error(
    'usage: node scripts/seed-user.js <username> "<Display Name>" "<Company>" [password] [existing-company-id]',
  );
  process.exit(1);
}

// Ambiguity-free alphabet (no O/0, l/1) — these get typed by hand and read aloud.
function generate(len = 20) {
  const alpha = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return [...crypto.randomBytes(len)].map((b) => alpha[b % alpha.length]).join("");
}

// New company -> its creator owns the instance. Joining an existing one -> a
// member of somebody else's tenant.
const role = existingCompanyId ? "founder" : "admin";
const password = given || generate();
const salt = crypto.randomBytes(16).toString("hex");
const hash = crypto.createHash("sha256").update(`${salt}:${password}`).digest("hex");
const u = username.trim().toLowerCase();
const companyId = existingCompanyId || "co_" + crypto.randomBytes(9).toString("hex");
const now = Date.now();
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

if (!existingCompanyId) {
  console.log(
    `INSERT INTO companies (id, name, profile, categories, deck_status, created, updated)
VALUES (${q(companyId)}, ${q(company)}, '{}', '[]', 'empty', ${now}, ${now})
ON CONFLICT(id) DO NOTHING;`,
  );
}
console.log(
  `INSERT INTO users (username, display, company_id, role, salt, pw_hash, created, last_seen)
VALUES (${q(u)}, ${q(display)}, ${q(companyId)}, ${q(role)}, ${q(salt)}, ${q(hash)}, ${now}, 0)
ON CONFLICT(username) DO UPDATE SET display=excluded.display, company_id=excluded.company_id,
  salt=excluded.salt, pw_hash=excluded.pw_hash;`,
);

console.error(
  `\n  user:       ${u}\n  password:   ${password}\n  role:       ${role}\n  company_id: ${companyId}\n`,
);
console.error(`  Seed the investor list into it:\n    node scripts/seed-investors.js ${companyId}\n`);
