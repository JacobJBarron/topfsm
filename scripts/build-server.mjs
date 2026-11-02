#!/usr/bin/env node
/**
 * Builds the single-process server used by the Dockerfile (Railway, Docker, any Node host):
 *   dist/server/server.mjs              web app + API + scheduler (apps/api/src/server.ts)
 *   dist/server/public/                 the built web app
 *   dist/server/scripts/migrate.mjs     applies database migrations (node scripts/migrate.mjs)
 *   dist/server/supabase/migrations/    the migrations it applies
 *   dist/server/assets/                 the review card's renderer (resvg.wasm), fonts and their licences
 *   dist/server/scripts/render-card.mjs renders a sample review card (node scripts/render-card.mjs --check)
 * Run with: node dist/server/server.mjs
 */
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist/server");
const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "scripts"), { recursive: true });

if (process.env.CREWTAVO_SKIP_WEB_BUILD !== "1") run("npm run build -w @crewtavo/web");
cpSync(join(root, "apps/web/dist"), join(out, "public"), { recursive: true });
cpSync(join(root, "supabase/migrations"), join(out, "supabase/migrations"), { recursive: true });
// The review card (apps/api/src/lib/reviewCard.ts) reads these next to the bundle: no node_modules there.
cpSync(join(root, "apps/api/assets/fonts"), join(out, "assets/fonts"), { recursive: true });
cpSync(join(root, "apps/api/assets/licenses"), join(out, "assets/licenses"), { recursive: true });
cpSync(createRequire(join(root, "apps/api/package.json")).resolve("@resvg/resvg-wasm/index_bg.wasm"), join(out, "assets/resvg.wasm"));

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  minify: true,
  logLevel: "warning",
  // Some dependencies still call require(); give ESM output a require that works.
  banner: { js: "import { createRequire as __gwCreateRequire } from 'node:module'; const require = __gwCreateRequire(import.meta.url);" },
};
await build({ ...common, entryPoints: [join(root, "apps/api/src/server.ts")], outfile: join(out, "server.mjs") });
await build({ ...common, entryPoints: [join(root, "scripts/migrate.mjs")], outfile: join(out, "scripts/migrate.mjs") });
await build({ ...common, entryPoints: [join(root, "apps/api/src/scripts/renderCard.ts")], outfile: join(out, "scripts/render-card.mjs") });
console.log("Server build written to dist/server (run: node dist/server/server.mjs)");
