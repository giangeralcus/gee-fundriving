// Sinkron peta kecil dari ../maps ke public/ buat dev & build.
// Peta OSM raksasa sengaja gak di-copy (limit file Pages 25 MiB);
// kalau mau dipakai di web, taruh manual di public/ terus ?map=/nama.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, "..", "public");
fs.mkdirSync(pub, { recursive: true });
for (const f of ["loop_city.json", "circle.json", "poi.json"]) {
  const src = path.join(here, "..", "..", "maps", f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(pub, f));
}
console.log("peta tersinkron ke public/");
