// Builds the whole app into one self-contained file: dist/index.html.
//   1. Compiles the Rust core to WebAssembly.
//   2. Bundles the background worker and the interface with esbuild.
//   3. Inlines styles, scripts and the WebAssembly module into the page.
// Usage (from web/): npm run build

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../..", import.meta.url));
const at = (p) => root + p;

console.log("Compiling the Rust core to WebAssembly…");
const cargo = spawnSync("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown"], {
  cwd: at("core"),
  stdio: "inherit",
});
if (cargo.status !== 0) process.exit(cargo.status ?? 1);
const wasm = readFileSync(at("core/target/wasm32-unknown-unknown/release/terrain_core.wasm"));

console.log("Bundling the interface…");
const bundle = async (entry, define = {}) => {
  const out = await build({ entryPoints: [at(entry)], bundle: true, format: "iife", minify: true, target: "es2022", write: false, define });
  return out.outputFiles[0].text;
};
const worker = await bundle("web/src/worker.ts");
const app = await bundle("web/src/main.ts", {
  __WORKER_SOURCE__: JSON.stringify(worker),
  __WASM_BASE64__: JSON.stringify(wasm.toString("base64")),
});

// A literal "</script" inside the bundle would end the script tag early.
const safe = (js) => js.replace(/<\/script/gi, "<\\/script");
const html = readFileSync(at("web/index.html"), "utf8")
  .replace("<!-- STYLES -->", () => readFileSync(at("web/src/styles.css"), "utf8"))
  .replace("<!-- SCRIPT -->", () => safe(app));

mkdirSync(at("dist"), { recursive: true });
writeFileSync(at("dist/index.html"), html);
console.log(`Wrote dist/index.html (${(html.length / 1024).toFixed(0)} KB, WebAssembly core ${(wasm.length / 1024).toFixed(0)} KB).`);
