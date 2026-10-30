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

/** One shape as the core sees it. */
export interface GuideShape {
  id: number;
  seed: number;
  /** Anchors the coastline detail: position (km) and rotation (radians). */
  frame: { x: number; y: number; angle: number };
  points: Vec2[];
  params: SegmentParams[]; // params[i] belongs to the segment from points[i] to points[i + 1]
}

/** Everything the core generates from. */
export interface Guides {
  worldSeed: number;
  shapes: GuideShape[];
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
  | { type: "guides"; version: number; guides: Guides };

export type FromCore =
  | { type: "frame"; version: number; rect: Rect; pixels: ArrayBuffer; computeMs: number }
  | { type: "error"; version: number; message: string };

/** Flat encoding the core reads; see core/src/ffi.rs. */
export function encodeGuides(guides: Guides): Float32Array {
  const shapes = guides.shapes.filter((s) => s.points.length >= 3);
  const size = 2 + shapes.reduce((n, s) => n + 6 + s.points.length * 5, 0);
  const out = new Float32Array(size);
  out[0] = guides.worldSeed;
  out[1] = shapes.length;
  let at = 2;
  for (const s of shapes) {
    out.set([s.id, s.seed, s.frame.x, s.frame.y, s.frame.angle, s.points.length], at);
    at += 6;
    for (const p of s.points) {
      out[at++] = p.x;
      out[at++] = p.y;
    }
    for (const p of s.params) {
      out[at++] = p.roughness;
      out[at++] = p.coves;
      out[at++] = p.shoreKm;
    }
  }
  return out;
}
