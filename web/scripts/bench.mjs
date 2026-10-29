// Times the WebAssembly core outside the browser.
// Usage: npm run bench -- [resolution]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const wasmPath = fileURLToPath(new URL("../../core/target/wasm32-unknown-unknown/release/terrain_core.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
const core = instance.exports;
const size = Number(process.argv[2] ?? 1024);
const EXTENT_KM = 1600;

const points = [[400, 300], [800, 220], [1150, 380], [1300, 750], [1180, 1150], [820, 1320], [450, 1200], [280, 820]];
const params = points.map(() => [0.4, 0.5, 4]);

function send() {
  const data = [1234, points.length, ...points.flat(), ...params.flat()];
  const ptr = core.wm_inbox(data.length);
  new Float32Array(core.memory.buffer, ptr, data.length).set(data);
  const t = performance.now();
  const changed = core.wm_set_coast(data.length);
  return { ms: performance.now() - t, changed };
}

core.wm_init(size, size, EXTENT_KM);
const full = send();
console.log(`Resolution ${size}x${size}`);
console.log(`  Generate landmass (full map): ${full.ms.toFixed(1)} ms, ${full.changed} pixels`);

const slider = [];
for (let i = 0; i < 30; i++) { params[3][0] = (i % 10) / 10; slider.push(send()); }
const drag = [];
for (let i = 0; i < 30; i++) { points[5][0] += 2; points[5][1] += 1; drag.push(send()); }

const report = (name, runs) => {
  const ms = runs.map(r => r.ms).sort((a, b) => a - b);
  const px = runs[runs.length - 1].changed;
  console.log(`  ${name}: median ${ms[ms.length >> 1].toFixed(1)} ms, worst ${ms[ms.length - 1].toFixed(1)} ms, ~${px} pixels`);
};
report("Slider on one segment", slider);
report("Dragging one point   ", drag);
