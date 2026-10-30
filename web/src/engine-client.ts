// The interface's handle on the generation core.
//
// Edits can arrive far faster than the core can process them (a slider fires
// on every pixel of movement). Only one update is in flight at a time; while
// it runs, newer edits replace older waiting ones, so the core always works on
// the latest state and never on a backlog.

import { CoreHost } from "./core-host";
import type { FromCore, Guides, Rect, ToCore } from "./protocol";

import { WORKER_SOURCE, wasmBytes } from "./embedded";

export interface Frame {
  rect: Rect;
  pixels: Uint8ClampedArray<ArrayBuffer>;
  computeMs: number;
  totalMs: number;
  kind: ToCore["type"];
  /** Which `init` this frame belongs to. Frames from an older init are stale. */
  initVersion: number;
}


export class EngineClient {
  onFrame: (frame: Frame) => void = () => {};
  onError: (message: string) => void = () => {};
  mode: "background" | "main thread" = "background";

  private worker: Worker | null = null;
  private host: CoreHost | null = null;
  private version = 0;
  private inFlight: ToCore | null = null;
  private waitingInit: ToCore | null = null;
  private waitingGuides: ToCore | null = null;
  private sentAt = new Map<number, number>();
  private lastInit: ToCore | null = null;
  private lastGuides: ToCore | null = null;
  private appliedInit = 0;

  constructor() {
    try {
      const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
      this.worker = new Worker(url);
      this.worker.onmessage = (e: MessageEvent<FromCore>) => this.receive(e.data);
      this.worker.onerror = () => this.useMainThread();
    } catch {
      this.useMainThread();
    }
  }

  /** Start (or restart) the core on an area of the map. Returns the init's version. */
  init(width: number, height: number, widthKm: number, originX = 0, originY = 0): number {
    const msg: ToCore = {
      type: "init",
      version: ++this.version,
      wasm: new ArrayBuffer(0),
      width,
      height,
      widthKm,
      originX,
      originY,
    };
    this.lastInit = msg;
    this.waitingInit = msg;
    this.pump();
    return msg.version;
  }

  setGuides(guides: Guides): void {
    this.waitingGuides = { type: "guides", version: ++this.version, guides: structuredClone(guides) };
    this.lastGuides = this.waitingGuides;
    this.pump();
  }

  private pump(): void {
    if (this.inFlight) return;
    const next = this.waitingInit ?? this.waitingGuides;
    if (!next) return;
    if (next === this.waitingInit) this.waitingInit = null;
    else this.waitingGuides = null;
    this.inFlight = next;
    this.sentAt.set(next.version, performance.now());
    const msg = next.type === "init" ? { ...next, wasm: wasmBytes() } : next;
    if (this.worker) {
      this.worker.postMessage(msg, msg.type === "init" ? [msg.wasm] : []);
    } else {
      // Let the browser paint before computing on the interface thread.
      setTimeout(() => this.host!.handle(msg).then((out) => this.receive(out)), 0);
    }
  }

  private receive(out: FromCore): void {
    const request = this.inFlight;
    this.inFlight = null;
    const sent = this.sentAt.get(out.version) ?? performance.now();
    this.sentAt.delete(out.version);
    if (out.type === "error") {
      if (this.worker && request?.type === "init") {
        // Some browsers allow WebAssembly on the page but not in a worker.
        this.useMainThread();
        return;
      }
      this.onError(out.message);
    } else {
      if (request?.type === "init") this.appliedInit = request.version;
      this.onFrame({
        rect: out.rect,
        pixels: new Uint8ClampedArray(out.pixels as ArrayBuffer),
        computeMs: out.computeMs,
        totalMs: performance.now() - sent,
        kind: request?.type ?? "guides",
        initVersion: this.appliedInit,
      });
    }
    this.pump();
  }

  private useMainThread(): void {
    if (this.mode === "main thread") return;
    this.worker?.terminate();
    this.worker = null;
    this.host = new CoreHost();
    this.mode = "main thread";
    // Replay the latest state on the new host.
    this.inFlight = null;
    this.waitingInit = this.lastInit;
    this.waitingGuides = this.lastGuides;
    this.pump();
  }
}
