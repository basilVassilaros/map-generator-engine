// Runs the WebAssembly core. Used inside the background worker, or directly
// on the main thread if the browser refuses to start a worker.

import { encodeGuides, type FromCore, type Rect, type ToCore } from "./protocol";

interface CoreExports {
  memory: WebAssembly.Memory;
  wm_init(width: number, height: number, widthKm: number, originX: number, originY: number): number;
  wm_inbox(len: number): number;
  wm_set_shapes(len: number): number;
  wm_dirty(which: number): number;
  wm_rgba(): number;
  wm_render_terrain(rainfall: number, evaporation: number, latitude: number, rounds: number, style: number): number;
  wm_structure_ptr(): number;
  wm_structure_len(): number;
  wm_structure_load(len: number): number;
  wm_render_fine(style: number, rows: number, halo: number): number;
  wm_terrain_rgba(): number;
  wm_terrain_stat(which: number): number;
  wm_terrain_range(which: number): number;
  wm_generated_ptr(): number;
  wm_generated_len(): number;
  wm_fine_height(): number;
}

export class CoreHost {
  private core: CoreExports | null = null;
  private width = 0;
  private height = 0;
  /** The last frame sent was a terrain render, so the next live one must repaint everything. */
  private showingTerrain = false;

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
        this.height = msg.height;
        this.showingTerrain = false;
        return this.frame(msg.version, [0, 0, msg.width, msg.height], started);
      }
      if (msg.type === "terrain") {
        const core = this.require();
        const c = msg.climate;
        core.wm_render_terrain(c.rainfall, c.evaporation, c.latitude, c.rounds, c.style);
        this.showingTerrain = true;
        const out = this.frame(msg.version, [0, 0, this.width, this.height], started, core.wm_terrain_rgba());
        if (out.type === "frame") {
          out.lakes = core.wm_terrain_stat(0);
          out.rivers = core.wm_terrain_stat(1);
          // What fine-detail workers need to render any part of this map.
          out.structure = new Float32Array(core.memory.buffer, core.wm_structure_ptr(), core.wm_structure_len()).slice().buffer;
          out.planned = new Float32Array(core.memory.buffer, core.wm_generated_ptr(), core.wm_generated_len()).slice().buffer;
          out.range = [core.wm_terrain_range(0), core.wm_terrain_range(1)];
        }
        return out;
      }
      if (msg.type === "strip") return await this.strip(msg, started);
      if (msg.type === "tstrip") return await this.terrainStrip(msg, started);
      const core = this.require();
      const data = encodeGuides(msg.guides);
      const ptr = core.wm_inbox(data.length);
      new Float32Array(core.memory.buffer, ptr, data.length).set(data);
      core.wm_set_shapes(data.length);
      let rect: Rect = [core.wm_dirty(0), core.wm_dirty(1), core.wm_dirty(2), core.wm_dirty(3)];
      if (this.showingTerrain) {
        // The screen holds a terrain render: replace all of it with the live map.
        rect = [0, 0, this.width, this.height];
        this.showingTerrain = false;
      }
      return this.frame(msg.version, rect, started);
    } catch (err) {
      return { type: "error", version: msg.version, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * One strip of a full-detail export: the rows from `originY` down, with an
   * extra row above and below so hillshading at the strip's edges matches
   * its neighbours. Returns only the strip's own rows.
   */
  private async strip(msg: Extract<ToCore, { type: "strip" }>, started: number): Promise<FromCore> {
    if (!this.core) {
      if (!msg.wasm) throw new Error("The export worker needs the core.");
      const { instance } = await WebAssembly.instantiate(msg.wasm, {});
      this.core = instance.exports as unknown as CoreExports;
    }
    const core = this.core;
    const cell = msg.widthKm / msg.width;
    if (!core.wm_init(msg.width, msg.rows + 2, msg.widthKm, 0, msg.originY - cell)) {
      throw new Error("The core rejected an export strip.");
    }
    this.width = msg.width;
    const data = encodeGuides(msg.guides);
    const ptr = core.wm_inbox(data.length);
    new Float32Array(core.memory.buffer, ptr, data.length).set(data);
    core.wm_set_shapes(data.length);
    return this.frame(msg.version, [0, 1, msg.width, msg.rows + 1], started);
  }

  /** One strip of a fine-detail terrain render. */
  private async terrainStrip(msg: Extract<ToCore, { type: "tstrip" }>, started: number): Promise<FromCore> {
    if (!this.core) {
      if (!msg.wasm) throw new Error("The terrain worker needs the core.");
      const { instance } = await WebAssembly.instantiate(msg.wasm, {});
      this.core = instance.exports as unknown as CoreExports;
    }
    const core = this.core;
    if (msg.structure) {
      const data = new Float32Array(msg.structure);
      // Ask for the room first: it can grow (and so replace) the core's memory.
      const at = core.wm_inbox(data.length);
      new Float32Array(core.memory.buffer, at, data.length).set(data);
      if (!core.wm_structure_load(data.length)) throw new Error("The terrain data couldn't be loaded.");
    }
    const cell = msg.widthKm / msg.width;
    if (!core.wm_init(msg.width, msg.rows + 2 * msg.halo, msg.widthKm, msg.originX, msg.originY - msg.halo * cell)) {
      throw new Error("The core rejected a terrain strip.");
    }
    const guides = encodeGuides(msg.guides);
    const room = core.wm_inbox(guides.length);
    new Float32Array(core.memory.buffer, room, guides.length).set(guides);
    core.wm_set_shapes(guides.length);
    const ptr = core.wm_render_fine(msg.style, msg.rows, msg.halo);
    if (!ptr) throw new Error("No terrain data is loaded in this worker.");
    if (msg.heights) {
      const heights = new Float32Array(msg.width * msg.rows);
      heights.set(new Float32Array(core.memory.buffer, core.wm_fine_height(), heights.length));
      return { type: "frame", version: msg.version, rect: [0, 0, msg.width, msg.rows], pixels: heights.buffer, computeMs: performance.now() - started };
    }
    const out = new Uint8ClampedArray(msg.width * msg.rows * 4);
    out.set(new Uint8Array(core.memory.buffer, ptr, out.length));
    return { type: "frame", version: msg.version, rect: [0, 0, msg.width, msg.rows], pixels: out.buffer, computeMs: performance.now() - started };
  }

  private require(): CoreExports {
    if (!this.core) throw new Error("The core received an update before it was started.");
    return this.core;
  }

  /** Copy the changed rectangle of pixels out of WebAssembly memory. */
  private frame(version: number, rect: Rect, started: number, source?: number): FromCore {
    const core = this.require();
    const [x0, y0, x1, y1] = rect;
    const w = Math.max(0, x1 - x0);
    const h = Math.max(0, y1 - y0);
    const out = new Uint8ClampedArray(w * h * 4);
    // Read the pointer after the update: memory may have grown and moved.
    const all = new Uint8Array(core.memory.buffer, source ?? core.wm_rgba());
    for (let row = 0; row < h; row++) {
      const from = ((y0 + row) * this.width + x0) * 4;
      out.set(all.subarray(from, from + w * 4), row * w * 4);
    }
    return { type: "frame", version, rect, pixels: out.buffer, computeMs: performance.now() - started };
  }
}
