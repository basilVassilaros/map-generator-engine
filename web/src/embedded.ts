// The worker code and the WebAssembly core, inlined into the page by the
// build. Kept in one module so each is embedded exactly once.

declare const __WORKER_SOURCE__: string;
declare const __WASM_BASE64__: string;

export const WORKER_SOURCE: string = __WORKER_SOURCE__;

let wasm: Uint8Array | null = null;

/** A fresh copy of the core's bytes (safe to transfer to a worker). */
export function wasmBytes(): ArrayBuffer {
  if (!wasm) wasm = Uint8Array.from(atob(__WASM_BASE64__), (c) => c.charCodeAt(0));
  return wasm.slice().buffer;
}
