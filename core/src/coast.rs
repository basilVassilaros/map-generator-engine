//! The coastline guide: what the user drew, plus per-segment parameters,
//! and the functions that turn "distance from the coast" into terrain.

use crate::noise::{fbm, gradient};

/// Distance (km) beyond which the coastline no longer shapes the terrain.
/// Every coastal profile below must be fully flat beyond this distance.
pub const INFLUENCE_KM: f32 = 120.0;
/// Largest possible displacement of the coastline by noise (km).
pub const MAX_COAST_NOISE_KM: f32 = 90.0;
/// Distances are clamped here. A cell further than this from an edited segment
/// is guaranteed to be unaffected by the edit, which is what makes partial
/// (dirty-region) updates exact rather than approximate.
pub const CLAMP_KM: f32 = INFLUENCE_KM + MAX_COAST_NOISE_KM;

/// Shore slope distance limits (km). The profile saturates at 3x this value,
/// which must stay below INFLUENCE_KM.
pub const MIN_SHORE_KM: f32 = 0.1;
pub const MAX_SHORE_KM: f32 = 30.0;

/// Parameters the user sets on one segment of the coastline.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SegmentParams {
    /// 0..1, small-scale jaggedness of the shore.
    pub roughness: f32,
    /// 0..1, how many coves, bays and headlands form.
    pub coves: f32,
    /// Kilometres over which land rises from the shoreline.
    /// Short gives cliffs, long gives a gradual beach.
    pub shore_km: f32,
}

impl Default for SegmentParams {
    fn default() -> Self {
        Self { roughness: 0.4, coves: 0.5, shore_km: 4.0 }
    }
}

impl SegmentParams {
    pub fn sanitized(self) -> Self {
        Self {
            roughness: self.roughness.clamp(0.0, 1.0),
            coves: self.coves.clamp(0.0, 1.0),
            shore_km: self.shore_km.clamp(MIN_SHORE_KM, MAX_SHORE_KM),
        }
    }

    fn lerp(a: Self, b: Self, t: f32) -> Self {
        Self {
            roughness: a.roughness + (b.roughness - a.roughness) * t,
            coves: a.coves + (b.coves - a.coves) * t,
            shore_km: a.shore_km + (b.shore_km - a.shore_km) * t,
        }
    }
}

/// A closed coastline polygon. Segment `i` runs from point `i` to point `i + 1`
/// (wrapping), and `params[i]` belongs to segment `i`.
#[derive(Clone, Debug, PartialEq)]
pub struct Coastline {
    pub points: Vec<[f32; 2]>,
    pub params: Vec<SegmentParams>,
    pub seed: u32,
}

/// Where a shape's coastline detail is anchored: a position (km) and a
/// rotation (radians). Moving or rotating a shape moves its frame with it, so
/// the coves and headlands travel with the shape instead of changing.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Frame {
    pub x: f32,
    pub y: f32,
    pub angle: f32,
}

impl Frame {
    /// World position (km) to the shape's own coordinates.
    #[inline]
    pub fn to_local(&self, p: [f32; 2]) -> [f32; 2] {
        let (s, c) = (-self.angle).sin_cos();
        let dx = p[0] - self.x;
        let dy = p[1] - self.y;
        [c * dx - s * dy, s * dx + c * dy]
    }
}

/// One closed outline drawn by the user, with its own identity and frame.
#[derive(Clone, Debug, PartialEq)]
pub struct Shape {
    /// Stable identity, so the engine can tell an edited shape from a new one.
    pub id: u32,
    pub coast: Coastline,
    pub frame: Frame,
}

/// Fraction of each segment at either end that blends into the neighbouring
/// segment's parameters, so adjacent segments never meet at a visible seam.
const BLEND: f32 = 0.3;

impl Coastline {
    pub fn len(&self) -> usize {
        self.points.len()
    }

    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }

    pub fn is_valid(&self) -> bool {
        self.points.len() >= 3 && self.params.len() == self.points.len()
    }

    pub fn segment(&self, i: usize) -> ([f32; 2], [f32; 2]) {
        let n = self.points.len();
        (self.points[i], self.points[(i + 1) % n])
    }

    /// Parameters at position `t` (0..1) along segment `i`. Continuous across
    /// segment joins: both segments meeting at a point agree on its value.
    pub fn params_at(&self, i: usize, t: f32) -> SegmentParams {
        let n = self.params.len();
        let here = self.params[i];
        if t < BLEND {
            let prev = self.params[(i + n - 1) % n];
            let join = SegmentParams::lerp(prev, here, 0.5);
            SegmentParams::lerp(join, here, smoothstep(0.0, 1.0, t / BLEND))
        } else if t > 1.0 - BLEND {
            let next = self.params[(i + 1) % n];
            let join = SegmentParams::lerp(here, next, 0.5);
            SegmentParams::lerp(join, here, smoothstep(0.0, 1.0, (1.0 - t) / BLEND))
        } else {
            here
        }
    }
}

#[inline]
pub fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Distance from `p` to segment `a`-`b`, and the position along it (0..1).
#[inline]
pub fn distance_to_segment(p: [f32; 2], a: [f32; 2], b: [f32; 2]) -> (f32, f32) {
    let abx = b[0] - a[0];
    let aby = b[1] - a[1];
    let len2 = abx * abx + aby * aby;
    let t = if len2 > 1e-9 {
        (((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let dx = p[0] - (a[0] + abx * t);
    let dy = p[1] - (a[1] + aby * t);
    ((dx * dx + dy * dy).sqrt(), t)
}

/// Octaves needed for noise starting at `wavelength_km` to keep adding
/// detail down to the size of a cell, within `[min, max]`. Coarse maps use
/// `min`; zoomed-in views use more, so zooming reveals real detail.
pub fn octaves_for(wavelength_km: f32, cell_km: f32, min: u32, max: u32) -> u32 {
    let needed = (wavelength_km / (2.0 * cell_km)).log2().ceil().max(0.0) as u32 + 1;
    needed.clamp(min, max)
}

/// Noise bands that shape the shoreline. They depend only on position and
/// seed, never on slider values, so the engine computes them once and a
/// slider edit only re-weights them.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CoastBands {
    pub big: f32,
    pub mid: f32,
    pub small: f32,
    pub rough: f32,
}

pub fn coast_bands(x: f32, y: f32, seed: u32, cell_km: f32) -> CoastBands {
    // Warp the sample position first, so bays and headlands come out
    // irregular and elongated instead of round blobs.
    let wx = x + 70.0 * gradient(x / 320.0, y / 320.0, seed ^ 0x0011_7711);
    let wy = y + 70.0 * gradient(x / 320.0, y / 320.0, seed ^ 0x0022_8822);
    CoastBands {
        big: fbm(wx / 300.0, wy / 300.0, seed ^ 0x00a1_1a11, 2, 0.5),
        mid: fbm(wx / 100.0, wy / 100.0, seed ^ 0x00b2_2b22, 3, 0.55),
        small: fbm(wx / 32.0, wy / 32.0, seed ^ 0x00c3_3c33, octaves_for(32.0, cell_km, 3, 7), 0.5),
        rough: fbm(x / 14.0, y / 14.0, seed ^ 0x00d4_4d44, octaves_for(14.0, cell_km, 5, 9), 0.6),
    }
}

/// How far (km) the shoreline is pushed at a position. Positive pushes land
/// outwards. Always strictly within +/- MAX_COAST_NOISE_KM.
pub fn coastal_displacement(b: &CoastBands, p: &SegmentParams) -> f32 {
    let c = p.coves;
    // Raising "coves" deepens every band, the shorter ones most, so the coast
    // gains inlets and headlands rather than just getting larger wiggles.
    let raw = 2.2
        * ((25.0 + 35.0 * c) * b.big
            + (8.0 + 40.0 * c) * b.mid
            + (3.0 + 22.0 * c) * b.small
            + 12.0 * p.roughness * b.rough);
    // Soft limit: keeps the bound without flattening the extremes into plateaus.
    MAX_COAST_NOISE_KM * (raw / MAX_COAST_NOISE_KM).tanh()
}

/// Elevation (metres) for a cell `signed_km` from the shoreline
/// (positive inland, negative at sea).
/// `base` is the lowland height from `inland_base`.
pub fn elevation_from_coast(base: f32, signed_km: f32, p: &SegmentParams) -> f32 {
    if signed_km >= 0.0 {
        // Rises over 3x the shore distance, then stays flat. A short distance
        // reaches full height within a cell or two, which reads as a cliff.
        let s = (signed_km / (3.0 * p.shore_km)).min(1.0);
        let rise = 1.0 - (1.0 - s) * (1.0 - s);
        let interior = 160.0 * smoothstep(0.0, INFLUENCE_KM, signed_km);
        ((base + interior) * rise).max(0.5)
    } else {
        let out = -signed_km;
        let shelf_width = 2.0 * p.shore_km + 8.0;
        let shelf = 15.0 + 165.0 * smoothstep(0.0, shelf_width, out);
        let abyss = 3500.0 * smoothstep(50.0, INFLUENCE_KM, out);
        -(shelf + abyss)
    }
}

/// Gently varying lowland height, independent of the coastline.
pub fn inland_base(x: f32, y: f32, seed: u32, cell_km: f32) -> f32 {
    let broad = fbm(x / 420.0, y / 420.0, seed ^ 0x0e5e_e5e5, 4, 0.5);
    let detail = fbm(x / 30.0, y / 30.0, seed ^ 0x0f6f_f6f6, octaves_for(30.0, cell_km, 4, 9), 0.55);
    (200.0 + 260.0 * broad + 45.0 * detail).max(30.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_are_continuous_across_joins() {
        let coast = Coastline {
            points: vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]],
            params: vec![
                SegmentParams { roughness: 0.0, coves: 0.0, shore_km: 1.0 },
                SegmentParams { roughness: 1.0, coves: 1.0, shore_km: 20.0 },
                SegmentParams { roughness: 0.5, coves: 0.2, shore_km: 5.0 },
            ],
            seed: 1,
        };
        for i in 0..3 {
            let end = coast.params_at(i, 1.0);
            let start_next = coast.params_at((i + 1) % 3, 0.0);
            assert!((end.roughness - start_next.roughness).abs() < 1e-6);
            assert!((end.shore_km - start_next.shore_km).abs() < 1e-5);
        }
    }

    #[test]
    fn displacement_is_bounded() {
        let p = SegmentParams { roughness: 1.0, coves: 1.0, shore_km: 30.0 };
        for i in 0..50_000 {
            let bands = coast_bands(i as f32 * 0.91, i as f32 * 1.37, 3, 0.05);
            assert!(coastal_displacement(&bands, &p).abs() <= MAX_COAST_NOISE_KM);
        }
    }

    #[test]
    fn finer_cells_get_more_octaves() {
        assert_eq!(octaves_for(14.0, 1.5625, 5, 9), 5);
        assert!(octaves_for(14.0, 0.1, 5, 9) > 5);
        assert_eq!(octaves_for(14.0, 0.0001, 5, 9), 9);
    }

    #[test]
    fn profile_is_flat_beyond_influence() {
        // Required for exact partial updates: every parameter must stop
        // mattering once a cell is INFLUENCE_KM from the shore.
        let lo = SegmentParams { roughness: 0.0, coves: 0.0, shore_km: MIN_SHORE_KM };
        let hi = SegmentParams { roughness: 1.0, coves: 1.0, shore_km: MAX_SHORE_KM };
        for d in [INFLUENCE_KM, INFLUENCE_KM + 10.0, CLAMP_KM] {
            assert_eq!(elevation_from_coast(300.0, d, &lo), elevation_from_coast(300.0, d, &hi));
            assert_eq!(elevation_from_coast(300.0, -d, &lo), elevation_from_coast(300.0, -d, &hi));
        }
    }
}
