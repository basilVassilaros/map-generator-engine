// The line a mountain range or river follows: a smooth curve through its
// points. This mirrors core/src/features.rs (`curve_path`), so what is drawn
// on screen matches what the core generates.

import type { Vec2 } from "./protocol";

type P = [number, number];

const lerp = (a: P, b: P, t: number): P => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Centripetal Catmull-Rom through p1 and p2, at t (0..1) along that stretch. */
function catmull(p0: P, p1: P, p2: P, p3: P, t: number): P {
  const k = (a: P, b: P) => Math.sqrt(Math.max(Math.hypot(a[0] - b[0], a[1] - b[1]), 1e-3));
  const t0 = 0;
  const t1 = k(p0, p1);
  const t2 = t1 + k(p1, p2);
  const t3 = t2 + k(p2, p3);
  const tt = t1 + (t2 - t1) * t;
  const mix = (a: P, b: P, ta: number, tb: number): P => {
    const w = (tt - ta) / (tb - ta);
    return [a[0] * (1 - w) + b[0] * w, a[1] * (1 - w) + b[1] * w];
  };
  const a1 = mix(p0, p1, t0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  return mix(mix(a1, a2, t0, t2), mix(a2, a3, t1, t3), t1, t2);
}

const pt = (v: Vec2): P => [v.x, v.y];

/** A point on segment `i` (0..1 along it) of the curve. */
function sample(points: Vec2[], curviness: number, bends: number[], i: number, t: number): Vec2 {
  const n = points.length;
  const a = pt(points[i]);
  const b = pt(points[i + 1]);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const p0: P = i > 0 ? pt(points[i - 1]) : [2 * a[0] - b[0], 2 * a[1] - b[1]];
  const p3: P = i + 2 < n ? pt(points[i + 2]) : [2 * b[0] - a[0], 2 * b[1] - a[1]];
  const line = lerp(a, b, t);
  const c = Math.min(1, Math.max(0, curviness));
  const p = c > 0 && n >= 3 ? lerp(line, catmull(p0, a, b, p3, t), c) : line;
  const off = (bends[i] ?? 0) * Math.sin(Math.PI * t);
  if (len > 1e-6) {
    p[0] += (-(b[1] - a[1]) / len) * off;
    p[1] += ((b[0] - a[0]) / len) * off;
  }
  return { x: p[0], y: p[1] };
}

/** The whole curve as a polyline, sampled about every 6 km. */
export function curvePath(points: Vec2[], curviness: number, bends: number[]): Vec2[] {
  const n = points.length;
  if (n < 2 || (curviness <= 0 && bends.every((b) => !b))) return points;
  const out: Vec2[] = [points[0]];
  for (let i = 0; i < n - 1; i++) {
    const len = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    const steps = Math.min(64, Math.max(3, Math.ceil(len / 6)));
    for (let k = 1; k <= steps; k++) out.push(k === steps ? points[i + 1] : sample(points, curviness, bends, i, k / steps));
  }
  return out;
}

/** The middle of segment `i` of the curve, and the unit normal a bend moves it along. */
export function segmentMiddle(points: Vec2[], curviness: number, bends: number[], i: number): { at: Vec2; normal: Vec2 } {
  const a = points[i];
  const b = points[i + 1];
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { at: sample(points, curviness, bends, i, 0.5), normal: { x: -(b.y - a.y) / len, y: (b.x - a.x) / len } };
}

/**
 * A closed outline (a biome region) as a polyline: straight edges at
 * curviness 0, a smooth loop through the points at 1. The last point joins
 * back to the first; the result does not repeat the first point.
 */
export function closedCurve(points: Vec2[], curviness: number): Vec2[] {
  const n = points.length;
  if (n < 3 || curviness <= 0) return points;
  // Wrap the points so every edge, including the closing one, has neighbours on both sides.
  const wrapped = [points[n - 1], ...points, points[0], points[1]];
  const out: Vec2[] = [];
  for (let i = 1; i <= n; i++) {
    const a = wrapped[i];
    const b = wrapped[i + 1];
    const steps = Math.min(64, Math.max(3, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 6)));
    out.push(a);
    for (let k = 1; k < steps; k++) out.push(sample(wrapped, curviness, [], i, k / steps));
  }
  return out;
}
