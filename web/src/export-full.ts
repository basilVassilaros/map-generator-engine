// Full-detail export: the whole map regenerated at a chosen resolution, far
// beyond the working resolution. Several background workers each generate a
// horizontal strip at a time; strips are written into the PNG in order as
// they arrive, so memory stays small however large the image is.

import { CoreHost } from "./core-host";
import { PngWriter } from "./png-writer";
import type { FromCore, Guides, ToCore } from "./protocol";

import { WORKER_SOURCE, wasmBytes } from "./embedded";

/** About a million pixels per strip keeps each worker's memory modest. */
const PIXELS_PER_STRIP = 1_000_000;

export interface FullExportProgress {
  done: number;
  total: number;
  /** Estimated time remaining, once a few strips have finished. */
  remainingMs: number | null;
}

interface Runner {
  run(msg: ToCore, transfer: Transferable[]): Promise<FromCore>;
  stop(): void;
}

function workerRunner(): Runner | null {
  try {
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
    const worker = new Worker(url);
    let pending: ((out: FromCore) => void) | null = null;
    worker.onmessage = (e: MessageEvent<FromCore>) => pending?.(e.data);
    worker.onerror = () => pending?.({ type: "error", version: 0, message: "The export worker stopped." });
    return {
      run: (msg, transfer) =>
        new Promise((resolve) => {
          pending = resolve;
          worker.postMessage(msg, transfer);
        }),
      stop: () => worker.terminate(),
    };
  } catch {
    return null;
  }
}

function mainThreadRunner(): Runner {
  const host = new CoreHost();
  return { run: (msg) => host.handle(msg), stop: () => {} };
}

export async function exportFullDetail(
  size: number,
  extentKm: number,
  guides: Guides,
  onProgress: (p: FullExportProgress) => void,
  signal: AbortSignal,
): Promise<Blob> {
  const rowsPerStrip = Math.max(8, Math.floor(PIXELS_PER_STRIP / size));
  const strips = Math.ceil(size / rowsPerStrip);
  const cellKm = extentKm / size;
  const count = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 2) - 1, strips));

  let runners: Runner[] = [];
  for (let i = 0; i < count; i++) {
    const r = workerRunner();
    if (!r) break;
    runners.push(r);
  }
  if (!runners.length) runners = [mainThreadRunner()];

  const png = new PngWriter(size, size);
  const finished = new Map<number, Uint8ClampedArray>();
  let nextToWrite = 0;
  let next = 0;
  let done = 0;
  const started = performance.now();
  let writing = Promise.resolve();
  let failure: Error | null = null;

  // Write any strips that are ready, strictly in order.
  const flush = () => {
    writing = writing.then(async () => {
      while (finished.has(nextToWrite)) {
        const pixels = finished.get(nextToWrite)!;
        finished.delete(nextToWrite);
        const rows = Math.min(rowsPerStrip, size - nextToWrite * rowsPerStrip);
        await png.addRows(pixels, rows);
        nextToWrite++;
      }
    });
  };

  const work = async (runner: Runner, first: boolean) => {
    let sendCore = first;
    while (next < strips && !signal.aborted && !failure) {
      const index = next++;
      const rows = Math.min(rowsPerStrip, size - index * rowsPerStrip);
      const wasm = sendCore ? wasmBytes() : undefined;
      sendCore = false;
      const msg: ToCore = { type: "strip", version: index, wasm, width: size, rows, widthKm: extentKm, originY: index * rowsPerStrip * cellKm, guides };
      const out = await runner.run(msg, wasm ? [wasm] : []);
      if (out.type === "error") {
        failure = new Error(out.message);
        return;
      }
      finished.set(index, new Uint8ClampedArray(out.pixels));
      done++;
      const elapsed = performance.now() - started;
      onProgress({ done, total: strips, remainingMs: done >= Math.min(3, strips) ? (elapsed / done) * (strips - done) : null });
      flush();
    }
  };

  try {
    await Promise.all(runners.map((r) => work(r, true)));
    if (signal.aborted) throw new DOMException("Export cancelled.", "AbortError");
    if (failure) throw failure;
    await writing;
    return await png.finish();
  } catch (err) {
    await png.abort();
    throw err;
  } finally {
    runners.forEach((r) => r.stop());
  }
}
