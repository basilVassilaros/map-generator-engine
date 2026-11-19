//! Line and point features drawn over the shapes: mountains and rivers.
//!
//! A feature with one point is a single peak or a pool; with several, a
//! mountain range or a river running from its first point to its last.

use crate::noise::{fbm, gradient};
use crate::coast::octaves_for;
use crate::engine::Rect;

/// Nearest point on a polyline: distance (km) and how far along it (km).
pub fn nearest_on_path(p: [f32; 2], pts: &[[f32; 2]]) -> (f32, f32) {
    if pts.len() == 1 {
        return (((p[0] - pts[0][0]).powi(2) + (p[1] - pts[0][1]).powi(2)).sqrt(), 0.0);
    }
    let mut best = (f32::MAX, 0.0);
    let mut travelled = 0.0;
    for w in pts.windows(2) {
        let (a, b) = (w[0], w[1]);
        let (abx, aby) = (b[0] - a[0], b[1] - a[1]);
        let len2 = abx * abx + aby * aby;
        let len = len2.sqrt();
        let t = if len2 > 1e-9 { (((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2).clamp(0.0, 1.0) } else { 0.0 };
        let (dx, dy) = (p[0] - (a[0] + abx * t), p[1] - (a[1] + aby * t));
        let d = (dx * dx + dy * dy).sqrt();
        if d < best.0 {
            best = (d, travelled + t * len);
        }
        travelled += len;
    }
    best
}

#[inline]
fn lerp2(a: [f32; 2], b: [f32; 2], t: f32) -> [f32; 2] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/// Centripetal Catmull-Rom through `p1` and `p2` (Barry-Goldman pyramid), at
/// `t` in 0..1 along that stretch. Centripetal spacing never loops or
/// overshoots, whatever the spacing of the points.
fn catmull(p0: [f32; 2], p1: [f32; 2], p2: [f32; 2], p3: [f32; 2], t: f32) -> [f32; 2] {
    let k = |a: [f32; 2], b: [f32; 2]| ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt().max(1e-3).sqrt();
    let (t0, t1) = (0.0, k(p0, p1));
    let (t2, t3) = (t1 + k(p1, p2), t1 + k(p1, p2) + k(p2, p3));
    let tt = t1 + (t2 - t1) * t;
    let mix = |a: [f32; 2], b: [f32; 2], ta: f32, tb: f32| {
        let w = (tt - ta) / (tb - ta);
        [a[0] * (1.0 - w) + b[0] * w, a[1] * (1.0 - w) + b[1] * w]
    };
    let (a1, a2, a3) = (mix(p0, p1, t0, t1), mix(p1, p2, t1, t2), mix(p2, p3, t2, t3));
    let (b1, b2) = (mix(a1, a2, t0, t2), mix(a2, a3, t1, t3));
    mix(b1, b2, t1, t2)
}

/// The line a drawn feature follows: a smooth curve through its points.
///
/// `curviness` blends from straight segments (0) to a fully smooth spline (1).
/// `bends[i]` bows segment `i` sideways by that many km at its middle (positive
/// to the left of its direction), so a `<` of three points becomes a `(`.
/// Sampled every ~6 km, a fixed spacing, so the same line results at any
/// resolution and zoom.
pub fn curve_path(points: &[[f32; 2]], curviness: f32, bends: &[f32]) -> Vec<[f32; 2]> {
    let n = points.len();
    let c = if curviness.is_finite() { curviness.clamp(0.0, 1.0) } else { 0.0 };
    let bend = |i: usize| bends.get(i).copied().filter(|b| b.is_finite()).unwrap_or(0.0);
    if n < 2 || (c == 0.0 && (0..n - 1).all(|i| bend(i) == 0.0)) {
        return points.to_vec();
    }
    let mut out = vec![points[0]];
    for i in 0..n - 1 {
        let (a, b) = (points[i], points[i + 1]);
        let len = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
        let steps = ((len / 6.0).ceil() as usize).clamp(3, 64);
        // Missing neighbours at the ends are mirrored, which keeps the end
        // segments gently curved rather than flattened.
        let p0 = if i > 0 { points[i - 1] } else { [2.0 * a[0] - b[0], 2.0 * a[1] - b[1]] };
        let p3 = if i + 2 < n { points[i + 2] } else { [2.0 * b[0] - a[0], 2.0 * b[1] - a[1]] };
        let normal = if len > 1e-6 { [-(b[1] - a[1]) / len, (b[0] - a[0]) / len] } else { [0.0, 0.0] };
        for k in 1..=steps {
            let t = k as f32 / steps as f32;
            let line = lerp2(a, b, t);
            let mut p = if c > 0.0 && n >= 3 { lerp2(line, catmull(p0, a, b, p3, t), c) } else { line };
            let off = bend(i) * (std::f32::consts::PI * t).sin();
            p[0] += normal[0] * off;
            p[1] += normal[1] * off;
            out.push(if k == steps { b } else { p });
        }
    }
    out
}

/// A single peak (one point) or a range (a line of points).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Mountain {
    pub id: u32,
    pub seed: u32,
    pub points: Vec<[f32; 2]>,
    /// Height of the highest summits above the ground around (m).
    pub height: f32,
    /// How far the slopes spread to either side of the crest (km).
    pub width_km: f32,
    /// 0..1: smooth domes to jagged, spurred ridges.
    pub rugged: f32,
    /// Cells this mountain can affect; filled in by the engine.
    pub rect: Rect,
    /// 0..1: straight segments to a smooth curve through the points.
    pub curviness: f32,
    /// Sideways bow of each segment (km); see `curve_path`.
    pub bends: Vec<f32>,
    /// The curve itself; filled in by the engine.
    pub path: Vec<[f32; 2]>,
}

impl Mountain {
    /// The furthest (km) from its crest line that this mountain changes the ground.
    pub fn reach_km(&self) -> f32 {
        self.width_km * 1.5
    }

    /// Height (m) this mountain adds at world position `p`.
    ///
    /// Real ranges are not smooth walls: summits alternate with saddles along
    /// the crest, slopes are concave (steep near the top, gentle at the
    /// foot), and spurs branch off sideways. Here the crest height varies
    /// along its length, the footprint is warped by noise so spurs and
    /// embayments form, and ridged noise adds sharp secondary ridges.
    pub fn height_at(&self, p: [f32; 2], cell_km: f32) -> f32 {
        let w = self.width_km.max(0.5);
        let (d, along) = nearest_on_path(p, if self.path.is_empty() { &self.points } else { &self.path });
        if d >= w * 1.5 {
            return 0.0;
        }
        let crest = 0.72 + 0.28 * gradient(along / (w * 1.3), 7.3, self.seed);
        let warp = fbm(p[0] / (w * 0.9), p[1] / (w * 0.9), self.seed ^ 0x51a1, 3, 0.5);
        let dn = (d / w) * (1.0 + 0.4 * self.rugged * warp);
        let slope = (-(dn * 2.2).powf(1.3)).exp() * (1.0 - smooth01((dn - 1.0) / 0.5));
        // Ridged noise: sharp crests where the noise crosses zero.
        let octaves = octaves_for(w * 0.5, cell_km, 3, 7);
        let (mut ridges, mut amp, mut freq, mut norm) = (0.0, 1.0, 1.0 / (w * 0.5), 0.0);
        for o in 0..octaves {
            let n = 1.0 - gradient(p[0] * freq, p[1] * freq, self.seed ^ (0x9d00 + o)).abs();
            ridges += amp * n * n;
            norm += amp;
            amp *= 0.5;
            freq *= 2.0;
        }
        let detail = 1.0 + self.rugged * 0.9 * (ridges / norm - 0.55);
        (self.height * crest * slope * detail).max(0.0)
    }
}

#[inline]
fn smooth01(x: f32) -> f32 {
    let t = x.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// A drawn river (a line, flowing from its first point to its last) or a
/// pool (one point).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct River {
    pub id: u32,
    pub points: Vec<[f32; 2]>,
    /// Width of the water (km). A pool's diameter.
    pub width_km: f32,
    /// Depth of the channel below its banks (m).
    pub depth_m: f32,
    pub curviness: f32,
    pub bends: Vec<f32>,
    /// The curve itself; filled in by the engine.
    pub path: Vec<[f32; 2]>,
}

/// A biome region painted by the user: inside it, the climate and tree cover
/// are what the user chose instead of what the map's latitude and winds give.
#[derive(Clone, Debug, PartialEq)]
pub struct Region {
    pub id: u32,
    /// A closed outline (km).
    pub points: Vec<[f32; 2]>,
    /// Rainfall inside the region (mm a year).
    pub rainfall_mm: f32,
    /// 0..1: how humid. Dry air makes the same rain go less far for plants.
    pub humidity: f32,
    /// 0..1: how much of the ground is under trees.
    pub forest: f32,
    /// Mean temperature at sea level (°C), or NaN to keep the latitude's own.
    pub temp_c: f32,
    /// Width (km) of the soft edge where the region blends into its surroundings.
    pub feather_km: f32,
}

impl Region {
    /// How strongly the region applies at a position: 0 outside, 1 well
    /// inside, blending across its soft edge.
    pub fn weight(&self, p: [f32; 2]) -> f32 {
        let pts = &self.points;
        let n = pts.len();
        if n < 3 {
            return 0.0;
        }
        let (mut inside, mut nearest) = (false, f32::MAX);
        for i in 0..n {
            let (a, b) = (pts[i], pts[(i + 1) % n]);
            if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0] {
                inside = !inside;
            }
            let (abx, aby) = (b[0] - a[0], b[1] - a[1]);
            let len2 = abx * abx + aby * aby;
            let t = if len2 > 1e-9 { (((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2).clamp(0.0, 1.0) } else { 0.0 };
            nearest = nearest.min((p[0] - (a[0] + abx * t)).hypot(p[1] - (a[1] + aby * t)));
        }
        let signed = if inside { nearest } else { -nearest };
        let half = (self.feather_km * 0.5).max(0.01);
        smooth01((signed + half) / (2.0 * half))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pointed_vee_becomes_a_smooth_bow() {
        // Three points forming "<": the vertex is the leftmost point.
        let vee = [[100.0, 0.0], [0.0, 100.0], [100.0, 200.0]];
        assert_eq!(curve_path(&vee, 0.0, &[]), vee.to_vec(), "curviness 0 leaves it straight");
        let bow = curve_path(&vee, 1.0, &[]);
        assert!(bow.iter().any(|p| (p[0] - 0.0).abs() < 1e-3 && (p[1] - 100.0).abs() < 1e-3), "passes through the vertex");
        // Halfway down the first arm the straight line is at x = 50; the bow is further left.
        let at_50 = bow.iter().min_by(|a, b| (a[1] - 50.0).abs().total_cmp(&(b[1] - 50.0).abs())).unwrap();
        assert!(at_50[0] < 45.0, "bow x at y=50 is {}", at_50[0]);
        // Smooth at the vertex: the path is vertical there, not pointed.
        let i = bow.iter().position(|p| (p[1] - 100.0).abs() < 1e-3).unwrap();
        let (before, after) = (bow[i - 1], bow[i + 1]);
        assert!(after[0] > 0.0 && before[0] > 0.0 && (after[0] - before[0]).abs() < 4.0, "symmetric and smooth at the vertex");
    }

    #[test]
    fn curves_pass_through_every_point_and_bends_bow_a_segment() {
        let pts = [[0.0, 0.0], [60.0, 20.0], [120.0, -10.0], [200.0, 40.0]];
        let path = curve_path(&pts, 0.7, &[]);
        for p in pts {
            assert!(path.iter().any(|q| (q[0] - p[0]).abs() < 1e-3 && (q[1] - p[1]).abs() < 1e-3), "missing {p:?}");
        }
        let straight = curve_path(&[[0.0, 0.0], [100.0, 0.0]], 0.0, &[30.0]);
        let top = straight.iter().map(|p| p[1]).fold(0.0f32, f32::max);
        assert!((top - 30.0).abs() < 1.0, "bow of {top} km, wanted 30");
        assert_eq!(*straight.last().unwrap(), [100.0, 0.0], "ends where the segment ends");
    }
}
