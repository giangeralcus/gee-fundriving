import { defineConfig } from "vite";

// Peta kecil disinkronkan ke public/ oleh scripts/sync-map.mjs (dijalankan
// sebelum dev/build) — satu sumber kebenaran sama dgn versi Python di ../maps.
export default defineConfig({
  server: { port: 5173 },
  worker: { format: "es" },
});
