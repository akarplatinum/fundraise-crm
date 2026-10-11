#!/usr/bin/env node
// Assembles .assets/, the directory Cloudflare Pages serves:
//
//   .assets/            a copy of public/ (pages, app/ scripts and styles, vendor/)
//   .assets/_worker.js/ src/*.js, with index.js as the entry point
//
// _worker.js is a directory rather than one file so the Worker can use plain
// ES module imports across src/ with no bundler. The Worker runs before every
// request, which is what puts the app behind the sign-in.
//
// The investor list is not bundled. scripts/seed-investors.js loads it into the
// database at setup time.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, ".assets");

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, "public"), OUT, { recursive: true });
fs.cpSync(path.join(ROOT, "src"), path.join(OUT, "_worker.js"), { recursive: true });

console.log(`Built ${path.relative(process.cwd(), OUT) || ".assets"}/`);
