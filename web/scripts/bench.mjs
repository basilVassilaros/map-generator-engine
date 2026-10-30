// Times the WebAssembly core outside the browser, with three shapes.
// Usage (from web/): npm run bench -- [resolution]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const wasmPath = fileURLToPath(new URL("../../core/target/wasm32-unknown-unknown/release/terrain_core.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
const core = instance.exports;
const size = Number(process.argv[2] ?? 1024);
const EXTENT_KM = 1600;

const island = (id, cx, cy, r) => {
  const points = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2;
    return [cx + r * Math.cos(a), cy + r * 0.8 * Math.sin(a)];
  });
  return { id, seed: id * 101, frame: [cx, cy, 0], points, params: points.map(() => [0.4, 0.5, 4]) };
};
const shapes = [island(1, 500, 500, 320), island(2, 1150, 650, 280), island(3, 800, 1250, 200)];

function send() {
  const data = [7, shapes.length];
  for (const s of shapes) data.push(s.id, s.seed, ...s.frame, s.points.length, ...s.points.flat(), ...s.params.flat());
  const ptr = core.wm_inbox(data.length);
  new Float32Array(core.memory.buffer, ptr, data.length).set(data);
  const t = performance.now();
  const changed = core.wm_set_shapes(data.length);
  return { ms: performance.now() - t, changed };
}

core.wm_init(size, size, EXTENT_KM, 0, 0);
const full = send();
console.log(`Resolution ${size}x${size}, ${shapes.length} shapes`);
console.log(`  Generate landmass (full map): ${full.ms.toFixed(1)} ms`);

const runs = {};
const time = (name, edit) => { runs[name] = []; for (let i = 0; i < 20; i++) { edit(i); runs[name].push(send()); } };
time("Slider on one segment ", (i) => { shapes[0].params[3][0] = (i % 10) / 10; });
time("Dragging one point    ", () => { shapes[1].points[2][0] += 2; shapes[1].points[2][1] += 1; });
time("Moving a whole shape  ", () => { for (const p of shapes[2].points) { p[0] += 3; p[1] -= 2; } shapes[2].frame[0] += 3; shapes[2].frame[1] -= 2; });
time("Resizing a whole shape", () => { const [cx, cy] = shapes[2].frame; for (const p of shapes[2].points) { p[0] = cx + (p[0] - cx) * 1.01; p[1] = cy + (p[1] - cy) * 1.01; } });
for (const [name, r] of Object.entries(runs)) {
  const ms = r.map((x) => x.ms).sort((a, b) => a - b);
  console.log(`  ${name}: median ${ms[ms.length >> 1].toFixed(1)} ms, worst ${ms[ms.length - 1].toFixed(1)} ms, ~${r[r.length - 1].changed} pixels`);
}
