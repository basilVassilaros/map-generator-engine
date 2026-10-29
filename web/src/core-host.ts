// Runs the WebAssembly core. Used inside the background worker, or directly
// on the main thread if the browser refuses to start a worker.

import { encodeCoast, type FromCore, type Rect, type ToCore } from "./protocol";

interface CoreExports {
  memory: WebAssembly.Memory;
  wm_init(width: number, height: number, widthKm: number, originX: number, originY: number): number;
  wm_inbox(len: number): number;
  wm_set_coast(len: number): number;
  wm_dirty(which: number): number;
  wm_rgba(): number;
}

export class CoreHost {
  private core: CoreExports | null = null;
  private width = 0;

  async handle(msg: ToCore): Promise<FromCore> {
    const started = performance.now();
    try {
      if (msg.type === "init") {
        if (!this.core) {
          const { instance } = await WebAssembly.instantiate(msg.wasm, {});
          this.core = instance.exports as unknown as CoreExports;
        }
        if (!this.core.wm_init(msg.width, msg.height, msg.widthKm, msg.originX, msg.originY)) {
          throw new Error(`The core rejected a ${msg.width}×${msg.height} map.`);
        }
        this.width = msg.width;
        return this.frame(msg.version, [0, 0, msg.width, msg.height], started);
      }
      const core = this.require();
      const data = encodeCoast(msg.coast);
      const ptr = core.wm_inbox(data.length);
      new Float32Array(core.memory.buffer, ptr, data.length).set(data);
      core.wm_set_coast(data.length);
      const rect: Rect = [core.wm_dirty(0), core.wm_dirty(1), core.wm_dirty(2), core.wm_dirty(3)];
      return this.frame(msg.version, rect, started);
    } catch (err) {
      return { type: "error", version: msg.version, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private require(): CoreExports {
    if (!this.core) throw new Error("The core received an update before it was started.");
    return this.core;
  }

  /** Copy the changed rectangle of pixels out of WebAssembly memory. */
  private frame(version: number, rect: Rect, started: number): FromCore {
    const core = this.require();
    const [x0, y0, x1, y1] = rect;
    const w = Math.max(0, x1 - x0);
    const h = Math.max(0, y1 - y0);
    const out = new Uint8ClampedArray(w * h * 4);
    // Read the pointer after the update: memory may have grown and moved.
    const all = new Uint8Array(core.memory.buffer, core.wm_rgba());
    for (let row = 0; row < h; row++) {
      const from = ((y0 + row) * this.width + x0) * 4;
      out.set(all.subarray(from, from + w * 4), row * w * 4);
    }
    return { type: "frame", version, rect, pixels: out.buffer, computeMs: performance.now() - started };
  }
}
