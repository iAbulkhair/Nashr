// Client JS sizes of a finished `next build --webpack`, gzip, in bytes (rule 2100). Next 16 no longer prints a First Load JS
// column, so this reads the build output:
//   shared  the runtime chunks every page loads (rootMainFiles in build-manifest.json; polyfills are nomodule and left out)
//   own     per route: the route's page chunk plus the layout chunks above it (static/chunks/app/**)
//   total   every client chunk of the build except polyfills (counts the numbered chunks webpack shares between routes)
// A route's First Load JS is about shared + own + the numbered shared chunks it uses; those cannot be told apart per route,
// so compare `own` for the route you changed and `total` for the whole app.
//   node scripts/route-sizes.mjs [.next] [out.json]
//   node scripts/route-sizes.mjs --diff before.json after.json
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

if (process.argv[2] === "--diff") {
  const [a, b] = process.argv.slice(3).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
  const kb = (n) => (n / 1024).toFixed(1);
  console.log(`shared ${kb(a.sharedGz)} -> ${kb(b.sharedGz)} kB, total ${kb(a.totalGz)} -> ${kb(b.totalGz)} kB`);
  for (const [k, v] of Object.entries(b.routes)) {
    const before = a.routes[k]?.ownGz;
    if (before !== undefined && Math.abs(v.ownGz - before) >= 100) console.log(`${((v.ownGz - before) / 1024).toFixed(1).padStart(7)} kB  own ${kb(before)} -> ${kb(v.ownGz)}  ${k}`);
  }
  process.exit(0);
}

const root = process.argv[2] || ".next";
const out = process.argv[3];
const gzSize = (rel) => zlib.gzipSync(fs.readFileSync(path.join(root, rel))).length;
const manifest = JSON.parse(fs.readFileSync(path.join(root, "build-manifest.json"), "utf8"));
const sharedGz = (manifest.rootMainFiles || []).filter((f) => f.endsWith(".js")).reduce((a, f) => a + gzSize(f), 0);

const chunks = path.join(root, "static/chunks");
const all = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".js")) all.push(path.relative(root, p));
  }
})(chunks);
const totalGz = all.filter((f) => !path.basename(f).startsWith("polyfills-")).reduce((a, f) => a + gzSize(f), 0);

// static/chunks/app/<dir>/page-<hash>.js and layout-<hash>.js, keyed by <dir>.
const appChunks = new Map();
for (const f of all) {
  const m = f.match(/^static\/chunks\/app\/(.*?)\/?(page|layout|not-found|global-error)-[0-9a-f]+\.js$/);
  if (m) appChunks.set(`${m[1]}|${m[2]}`, f);
}
const routes = {};
const manifestDirs = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === "page_client-reference-manifest.js") manifestDirs.push(path.relative(path.join(root, "server/app"), d));
  }
})(path.join(root, "server/app"));
for (const dir of manifestDirs) {
  const segs = dir.split("/").filter(Boolean);
  const files = [appChunks.get(`${segs.join("/")}|page`)];
  for (let i = 0; i <= segs.length; i++) files.push(appChunks.get(`${segs.slice(0, i).join("/")}|layout`));
  const own = [...new Set(files.filter(Boolean))];
  routes["/" + segs.join("/")] = { ownGz: own.reduce((a, f) => a + gzSize(f), 0), chunks: own.length };
}
if (out) fs.writeFileSync(out, JSON.stringify({ sharedGz, totalGz, routes }, null, 1));
const top = Object.entries(routes).sort((a, b) => b[1].ownGz - a[1].ownGz);
console.log(`shared ${(sharedGz / 1024).toFixed(1)} kB, total ${(totalGz / 1024).toFixed(1)} kB gzip, ${all.length} chunks, ${top.length} routes`);
for (const [k, v] of top) console.log(`${(v.ownGz / 1024).toFixed(1).padStart(8)} kB  ${k}`);
