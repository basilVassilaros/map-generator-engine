// Shared types and the message protocol between the interface and the core.

export interface Vec2 {
  x: number; // kilometres from the left edge of the map
  y: number; // kilometres from the top edge of the map
}

export interface SegmentParams {
  roughness: number; // 0..1
  coves: number; // 0..1
  shoreKm: number; // 0.1..30
}

export interface CoastGuide {
  points: Vec2[];
  params: SegmentParams[]; // params[i] belongs to the segment from points[i] to points[i + 1]
  seed: number;
}

export const DEFAULT_PARAMS: Readonly<SegmentParams> = { roughness: 0.4, coves: 0.5, shoreKm: 4 };
export const MIN_SHORE_KM = 0.1;
export const MAX_SHORE_KM = 30;

export type Rect = [x0: number, y0: number, x1: number, y1: number];

export type ToCore =
  | {
      type: "init";
      version: number;
      wasm: ArrayBuffer;
      width: number;
      height: number;
      /** Real width of the area covered, and its top-left corner, in km. */
      widthKm: number;
      originX: number;
      originY: number;
    }
  | { type: "coast"; version: number; coast: CoastGuide | null };

export type FromCore =
  | { type: "frame"; version: number; rect: Rect; pixels: ArrayBuffer; computeMs: number }
  | { type: "error"; version: number; message: string };

/** Flat encoding the core reads; see core/src/ffi.rs. */
export function encodeCoast(coast: CoastGuide | null): Float32Array {
  if (!coast || coast.points.length < 3) return new Float32Array([0, 0]);
  const n = coast.points.length;
  const out = new Float32Array(2 + n * 5);
  out[0] = coast.seed;
  out[1] = n;
  coast.points.forEach((p, i) => {
    out[2 + i * 2] = p.x;
    out[3 + i * 2] = p.y;
  });
  coast.params.forEach((p, i) => {
    const at = 2 + n * 2 + i * 3;
    out[at] = p.roughness;
    out[at + 1] = p.coves;
    out[at + 2] = p.shoreKm;
  });
  return out;
}
