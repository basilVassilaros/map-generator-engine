// Fine-detail terrain render: a window onto the map, at any resolution.
//
// Stage A (the terrain render on the working grid) leaves a "structure": the
// valleys it cut, rain, where lakes and floods lie, and the drainage network.
// Here, workers each render strips of a window from that structure, adding
// detail down to the pixel (see core/src/fine.rs). Strips come back as they
// finish, so the picture fills in; every strip is independent, so more
// threads mean a faster render, and memory stays flat however large the image.

import { wasmBytes } from "./embedded";
import { mainThreadRunner, workerRunner, type Runner } from "./export-full";
import { PngWriter } from "./png-writer";
import type { FromCore, Guides, ToCore } from "./protocol";

/** About a million pixels per strip keeps each worker's memory modest. */
const PIXELS_PER_STRIP = 1_000_000;
/** Rows of context above and below a strip, for hillshade and occlusion. */
const HALO = 3;

export interface TerrainWindow {
  /** The world position (km) of the window's top-left corner, and its real size. */
  x: number;
  y: number;
  widthKm: number;
  heightKm: number;
  /** Output size in pixels; squares of ground, so the aspect ratio must match. */
  width: number;
  height: number;
}

/** A window over `area` (km) whose longer side is `longSide` pixels. */
export function windowOver(area: { x: number; y: number; w: number; h: number }, longSide: number): TerrainWindow {
  const landscape = area.w >= area.h;
  const width = landscape ? longSide : Math.max(16, Math.round((longSide * area.w) / area.h));
  const height = landscape ? Math.max(16, Math.round((longSide * area.h) / area.w)) : longSide;
  return { x: area.x, y: area.y, widthKm: area.w, heightKm: area.h, width, height };
}

export interface StripResult {
  /** Index of the strip, its first row in the output, its row count, and RGBA pixels (or f32 heights). */
  index: number;
  row: number;
  rows: number;
  pixels: Uint8ClampedArray<ArrayBuffer>;
  heights?: Float32Array<ArrayBuffer>;
}

export async function renderTerrainWindow(
  win: TerrainWindow,
  structure: ArrayBuffer,
  guides: Guides,
  style: number,
  onStrip: (strip: StripResult, done: number, total: number) => void,
  signal: AbortSignal,
  heights = false,
): Promise<void> {
  const rowsPerStrip = Math.max(8, Math.floor(PIXELS_PER_STRIP / win.width));
  const strips = Math.ceil(win.height / rowsPerStrip);
  const cell = win.widthKm / win.width;
  const count = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1, strips));

  let runners: Runner[] = [];
  for (let i = 0; i < count; i++) {
    const r = workerRunner();
    if (!r) break;
    runners.push(r);
  }
  if (!runners.length) runners = [mainThreadRunner()];

  let next = 0;
  let done = 0;
  let failure: Error | null = null;

  const work = async (runner: Runner) => {
    let first = true;
    while (next < strips && !signal.aborted && !failure) {
      const index = next++;
      const row = index * rowsPerStrip;
      const rows = Math.min(rowsPerStrip, win.height - row);
      const msg: ToCore = {
        type: "tstrip",
        version: index,
        wasm: first ? wasmBytes() : undefined,
        // Each worker gets its own copy of the structure, once.
        structure: first ? structure.slice(0) : undefined,
        guides,
        width: win.width,
        rows,
        halo: HALO,
        widthKm: win.widthKm,
        originX: win.x,
        originY: win.y + row * cell,
        style,
        heights,
      };
      const transfer = [msg.wasm, msg.structure].filter((b): b is ArrayBuffer => !!b);
      first = false;
      const out: FromCore = await runner.run(msg, transfer);
      if (out.type === "error") {
        failure = new Error(out.message);
        return;
      }
      done++;
      const buf = out.pixels as ArrayBuffer;
      onStrip(heights ? { index, row, rows, pixels: new Uint8ClampedArray(0), heights: new Float32Array(buf) } : { index, row, rows, pixels: new Uint8ClampedArray(buf) }, done, strips);
    }
  };

  try {
    await Promise.all(runners.map(work));
    if (signal.aborted) throw new DOMException("Render cancelled.", "AbortError");
    if (failure) throw failure;
  } finally {
    runners.forEach((r) => r.stop());
  }
}

export interface TerrainExport {
  /** "colour" for the satellite picture, "height" for a 16-bit greyscale heightmap. */
  kind: "colour" | "height";
  /** For heightmaps: the heights (m) written as 0 and 65535. */
  low?: number;
  high?: number;
}

/**
 * Render a terrain window in fine detail straight into a PNG, strip by strip.
 * Strips finish in any order and are written in order, so the image can be
 * far larger than a canvas allows and memory stays modest.
 */
export async function exportTerrainPng(
  win: TerrainWindow,
  structure: ArrayBuffer,
  guides: Guides,
  style: number,
  what: TerrainExport,
  onProgress: (done: number, total: number, remainingMs: number | null) => void,
  signal: AbortSignal,
): Promise<Blob> {
  const png = new PngWriter(win.width, win.height, what.kind === "height" ? "gray16" : "rgb8");
  const ready = new Map<number, StripResult>();
  let nextToWrite = 0;
  let writing = Promise.resolve();
  const started = performance.now();
  const low = what.low ?? 0;
  const span = Math.max(1, (what.high ?? 1) - low);
  const flush = () => {
    writing = writing.then(async () => {
      while (ready.has(nextToWrite)) {
        const strip = ready.get(nextToWrite)!;
        ready.delete(nextToWrite);
        if (strip.heights) await png.addHeights(strip.heights, strip.rows, low, span);
        else await png.addRows(strip.pixels, strip.rows);
        nextToWrite++;
      }
    });
  };
  try {
    await renderTerrainWindow(
      win,
      structure,
      guides,
      style,
      (strip, done, total) => {
        ready.set(strip.index, strip);
        const elapsed = performance.now() - started;
        onProgress(done, total, done >= Math.min(3, total) ? (elapsed / done) * (total - done) : null);
        flush();
      },
      signal,
      what.kind === "height",
    );
    await writing;
    return await png.finish();
  } catch (err) {
    await png.abort();
    throw err;
  }
}
