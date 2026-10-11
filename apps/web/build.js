#!/usr/bin/env node
// Assemble the .assets/ directory that Cloudflare Pages serves.
//
// The investor list (../../data) is deliberately NOT bundled. It is loaded into
// D1 by scripts/seed-investors.js at install time, so it lives in the database as per-company
// rows rather than as a 1.1MB static asset the Worker would have to gate on
// every request.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = __dirname;
const OUT = path.join(ROOT, ".assets");

function cp(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log("  +", path.relative(ROOT, dest));
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const page of ["index.html", "login.html", "signup.html", "onboarding.html"]) {
  cp(path.join(ROOT, "public", page), path.join(OUT, page));
}

// Motion is vendored rather than pulled from a CDN: the app should keep working
// offline, and a tool holding fundraising data shouldn't fetch a runtime script
// from a third party. `npm i motion` then re-copy dist/motion.js to update.
for (const f of fs.readdirSync(path.join(ROOT, "public/vendor"))) {
  cp(path.join(ROOT, "public/vendor", f), path.join(OUT, "vendor", f));
}

// Pages advanced mode: the Worker runs first for every request.
//
// _worker.js is emitted as a DIRECTORY, not a file. That format lets the Worker
// use real ES module imports across src/ files, which wrangler resolves at
// deploy time, so the app splits into modules with no bundler. src/index.js is
// the entry point; the other modules sit beside it and are imported by path.
const WORKER_DIR = path.join(OUT, "_worker.js");
for (const f of fs.readdirSync(path.join(ROOT, "src"))) {
  if (f.endsWith(".js")) cp(path.join(ROOT, "src", f), path.join(WORKER_DIR, f));
}

console.log("Built .assets/ (Pages)");
