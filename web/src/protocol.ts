// Shared types and the message protocol between the interface and the core.

export interface Vec2 {
  x: number; // kilometres from the left edge of the map
  y: number; // kilometres from the top edge of the map
}

export interface SegmentParams {
  roughness: number; // 0..1
  coves: number; // 0..1
  shoreKm: number; // 0.1..30
  /** How far the coast may grow beyond the drawn line, 0..70 km. */
  reachKm: number;
  /** How far the coast may cut inside the drawn line, 0..70 km. At 0, everything drawn keeps its kind. */
  insideKm: number;
}

/** One shape as the core sees it. */
export interface GuideShape {
  id: number;
  seed: number;
  /** Anchors the coastline detail: position (km), rotation (radians) and scale. */
  frame: { x: number; y: number; angle: number; scale: number };
  /** Land adds land at its height; water cuts out a lake, sea or bay. */
  kind: "land" | "water";
  /** Land: surface height (m). Water: surface level (m), or -Infinity to follow the ground. */
  height: number;
  points: Vec2[];
  params: SegmentParams[]; // params[i] belongs to the segment from points[i] to points[i + 1]
}

/** A single peak (one point) or a range (a line). */
export interface GuideMountain {
  id: number;
  seed: number;
  height: number; // m
  width: number; // km
  rugged: number; // 0..1
  curviness: number; // 0 straight segments .. 1 smooth curve
  bends: number[]; // km each segment bows sideways, one per segment
  points: Vec2[];
}

/** A pool (one point) or a river flowing from its first point to its last. */
export interface GuideRiver {
  id: number;
  width: number; // km
  depth: number; // m
  curviness: number;
  bends: number[];
  points: Vec2[];
}

/** A biome region: inside it the terrain render uses this climate and tree cover. */
export interface GuideRegion {
  id: number;
  rainfall: number; // mm a year
  humidity: number; // 0..1
  forest: number; // 0..1 of the ground under trees
  /** Mean temperature at sea level (°C), or null to follow the latitude. */
  temp: number | null;
  feather: number; // km of soft edge
  /** A closed outline (the curve, already smoothed). */
  points: Vec2[];
}

/** What the terrain render planned, as vectors (km). */
export interface PlannedFeatures {
  rivers: { points: Vec2[]; flow: number }[];
  hills: { points: Vec2[]; height: number; width: number }[];
  lakes: { points: Vec2[]; level: number }[];
}

/** Read `plan::Generated::to_f32` from the core. */
export function decodePlanned(buf: ArrayBuffer | undefined): PlannedFeatures {
  const out: PlannedFeatures = { rivers: [], hills: [], lakes: [] };
  if (!buf) return out;
  const d = new Float32Array(buf);
  let at = 0;
  const pts = (n: number) => {
    const p: Vec2[] = [];
    for (let i = 0; i < n; i++) p.push({ x: d[at + i * 2], y: d[at + i * 2 + 1] });
    at += n * 2;
    return p;
  };
  try {
    for (let k = d[at++]; k > 0; k--) {
      const n = d[at], flow = d[at + 1];
      at += 2;
      out.rivers.push({ flow, points: pts(n) });
    }
    for (let k = d[at++]; k > 0; k--) {
      const n = d[at], height = d[at + 1], width = d[at + 2];
      at += 3;
      out.hills.push({ height, width, points: pts(n) });
    }
    for (let k = d[at++]; k > 0; k--) {
      const n = d[at], level = d[at + 1];
      at += 2;
      out.lakes.push({ level, points: pts(n) });
    }
  } catch {
    // A short buffer just gives fewer features.
  }
  return out;
}

/** Settings for the terrain render. */
export interface ClimateSettings {
  rainfall: number; // mm per year, averaged over the land
  evaporation: number; // mm per year from open water
  latitude: number; // of the map's centre, degrees north
  rounds: number; // rounds of valley cutting
  style: number; // 0 true colour, 1 vivid, 2 atlas
}

/** Everything the core generates from. Shapes apply in order: outer first. */
export interface Guides {
  worldSeed: number;
  /** Width (pixels) of the land/water blend along coastlines; 0 = off. */
  smoothingPx: number;
  shapes: GuideShape[];
  mountains: GuideMountain[];
  rivers: GuideRiver[];
  /** Biome regions; they only affect the terrain render. */
  regions: GuideRegion[];
}

export const DEFAULT_PARAMS: Readonly<SegmentParams> = { roughness: 0.4, coves: 0.5, shoreKm: 4, reachKm: 25, insideKm: 0 };
export const MIN_SHORE_KM = 0.1;
export const MAX_SHORE_KM = 30;
export const MAX_REACH_KM = 70;

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
  | { type: "guides"; version: number; guides: Guides }
  /** Run the terrain render on the current map and return the whole picture. */
  | { type: "terrain"; version: number; climate: ClimateSettings }
  /**
   * Render rows of a terrain window in fine detail from the structure a
   * terrain render produced. `structure` is sent once per worker.
   */
  | {
      type: "tstrip";
      version: number;
      wasm?: ArrayBuffer;
      structure?: ArrayBuffer;
      guides: Guides;
      width: number;
      rows: number;
      halo: number;
      /** Real width of the output window (km), and the world position (km) of its first row. */
      widthKm: number;
      originX: number;
      originY: number;
      style: number;
      /** Return ground heights (f32 per pixel) instead of colour. */
      heights?: boolean;
    }
  | {
      /** Generate one horizontal strip of a full-detail export. */
      type: "strip";
      version: number;
      wasm?: ArrayBuffer;
      width: number;
      rows: number;
      widthKm: number;
      originY: number;
      guides: Guides;
    };

export type FromCore =
  | {
      type: "frame";
      version: number;
      rect: Rect;
      pixels: ArrayBuffer;
      computeMs: number;
      lakes?: number;
      rivers?: number;
      structure?: ArrayBuffer;
      /** The rivers, hills and lakes the terrain render planned (see `decodePlanned`). */
      planned?: ArrayBuffer;
      /** Lowest and highest ground in the terrain render (m). */
      range?: [number, number];
    }
  | { type: "error"; version: number; message: string };

/** Flat encoding the core reads; see core/src/ffi.rs. */
export function encodeGuides(guides: Guides): Float32Array {
  const shapes = guides.shapes.filter((s) => s.points.length >= 3);
  const out: number[] = [guides.worldSeed, guides.smoothingPx, shapes.length];
  for (const s of shapes) {
    out.push(s.id, s.seed, s.frame.x, s.frame.y, s.frame.angle, s.frame.scale, s.kind === "water" ? 1 : 0, s.height, s.points.length);
    for (const p of s.points) out.push(p.x, p.y);
    for (const p of s.params) out.push(p.roughness, p.coves, p.shoreKm, p.reachKm, p.insideKm);
  }
  const mountains = guides.mountains.filter((m) => m.points.length);
  out.push(mountains.length);
  for (const m of mountains) {
    out.push(m.id, m.seed, m.height, m.width, m.rugged, m.curviness, m.points.length);
    for (const p of m.points) out.push(p.x, p.y);
    for (let i = 0; i < m.points.length - 1; i++) out.push(m.bends[i] ?? 0);
  }
  const rivers = guides.rivers.filter((r) => r.points.length);
  out.push(rivers.length);
  for (const r of rivers) {
    out.push(r.id, r.width, r.depth, r.curviness, r.points.length);
    for (const p of r.points) out.push(p.x, p.y);
    for (let i = 0; i < r.points.length - 1; i++) out.push(r.bends[i] ?? 0);
  }
  const regions = (guides.regions ?? []).filter((r) => r.points.length >= 3);
  out.push(regions.length);
  for (const r of regions) {
    out.push(r.id, r.rainfall, r.humidity, r.forest, r.temp ?? NaN, r.feather, r.points.length);
    for (const p of r.points) out.push(p.x, p.y);
  }
  return Float32Array.from(out);
}
