// The coastline sliders, defined once and used by both the shape panel
// (values for every segment) and the segment panel (one segment's own
// adjustment on top of its shape's values).
//
// Values are kept in slider units. A segment's effective value is its shape's
// value plus the segment's adjustment, kept within the slider's range. So if
// a shape changes by x and a segment by y, that segment ends up changed by
// x + y, however the two were made.

import { MAX_SHORE_KM, MIN_SHORE_KM, type SegmentParams } from "./protocol";

export type SliderKey = "reach" | "inside" | "roughness" | "coves" | "shore";
export type SliderValues = Record<SliderKey, number>;

export interface SliderSpec {
  key: SliderKey;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  format(v: number): string;
}

// Shore distance spans 0.1 to 30 km, so its slider is logarithmic: equal
// travel gives an equal ratio, which keeps cliffs and beaches both usable.
const shoreKm = (v: number) => MIN_SHORE_KM * Math.pow(MAX_SHORE_KM / MIN_SHORE_KM, v / 1000);
const shoreSlider = (km: number) => Math.round((Math.log(km / MIN_SHORE_KM) / Math.log(MAX_SHORE_KM / MIN_SHORE_KM)) * 1000);

export const SLIDERS: SliderSpec[] = [
  { key: "reach", label: "Reach outside", hint: "How far the coast may grow beyond your line.", min: 0, max: 70, step: 1, format: (v) => `${Math.round(v)} km` },
  { key: "inside", label: "Reach inside", hint: "How far the coast may cut inside your line. At 0, everything you drew keeps its kind.", min: 0, max: 70, step: 1, format: (v) => `${Math.round(v)} km` },
  { key: "roughness", label: "Roughness", hint: "Fine jaggedness along the shore.", min: 0, max: 100, step: 1, format: (v) => `${Math.round(v)}%` },
  { key: "coves", label: "Coves and bays", hint: "A smooth coast at 0, many inlets and headlands at 100.", min: 0, max: 100, step: 1, format: (v) => `${Math.round(v)}%` },
  {
    key: "shore",
    label: "Shore slope",
    hint: "How far inland the land takes to rise. Short makes cliffs, long makes gentle beaches.",
    min: 0,
    max: 1000,
    step: 1,
    format: (v) => {
      const km = shoreKm(v);
      return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
    },
  },
];

export const DEFAULT_VALUES: Readonly<SliderValues> = { reach: 25, inside: 0, roughness: 40, coves: 50, shore: shoreSlider(4) };
export const NO_ADJUSTMENT: Readonly<SliderValues> = { reach: 0, inside: 0, roughness: 0, coves: 0, shore: 0 };

export function specFor(key: SliderKey): SliderSpec {
  return SLIDERS.find((s) => s.key === key)!;
}

/** Shape value plus segment adjustment, kept within each slider's range. */
export function effective(base: SliderValues, adjust: SliderValues): SliderValues {
  const out = {} as SliderValues;
  for (const s of SLIDERS) out[s.key] = Math.min(s.max, Math.max(s.min, base[s.key] + adjust[s.key]));
  return out;
}

export function toParams(v: SliderValues): SegmentParams {
  return { reachKm: v.reach, insideKm: v.inside, roughness: v.roughness / 100, coves: v.coves / 100, shoreKm: shoreKm(v.shore) };
}

export function isAdjusted(adjust: SliderValues): boolean {
  return SLIDERS.some((s) => adjust[s.key] !== 0);
}
