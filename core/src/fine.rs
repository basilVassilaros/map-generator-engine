//! Stage B of the terrain render: fine detail at any resolution.
//!
//! Stage A (`hydro::render`) works out the large-scale structure on the
//! working grid: climate, valleys, where lakes lie, where rivers run. It
//! hands the result over as a `Structure`. Stage B takes a *window* onto the
//! world at whatever resolution is wanted, builds the ground there from the
//! guides (shapes, mountains and drawn rivers, with detail down to the pixel),
//! applies the structure on top, and adds the detail real terrain has:
//!
//! * the valleys stage A cut are carved into the finer ground;
//! * fractal relief that is stronger on high, rugged ground;
//! * lakes and floods follow the real contour of the fine ground;
//! * rivers are drawn as smooth curves at their true width, wandering a little,
//!   with green banks and sediment plumes where they meet the sea.
//!
//! Stage B never moves what stage A decided: every river and lake is where the
//! structure put it, only refined. Everything depends on world position and the
//! structure alone, so a window cut into strips renders identically to one cut
//! whole (tested), which lets large renders run in strips on several threads.

use crate::engine::{Engine, LAKE, OCEAN, POOL};
use crate::plan::wander;
use crate::hydro::sea_level_temperature;
use crate::look::{self, Ground, Style};
use crate::noise::gradient;

/// How many per-cell fields a structure carries.
pub const FIELDS: usize = 9;
/// How many numbers come before the fields when a structure is flattened.
const HEAD: usize = 9;

/// What stage A decided, on the working grid.
pub struct Structure {
    pub w: usize,
    pub h: usize,
    pub origin: [f32; 2],
    pub cell_km: f32,
    pub latitude: f32,
    pub extent_km: f32,
    /// The smallest flow (m³/s) that counts as a stream.
    pub stream_from: f32,
    /// Height change from the plains' undulation and valley cutting (m).
    pub dz: Vec<f32>,
    /// Rainfall (mm a year).
    pub rain: Vec<f32>,
    /// Surface of a lake that formed in a hollow (NaN where none).
    pub lake: Vec<f32>,
    /// Level a hollow would fill to, where it has dried to a salt pan.
    pub pan: Vec<f32>,
    /// Surface of the water that flooded this cell (NaN where none).
    pub flood: Vec<f32>,
    /// Temperature change from biome regions (°C).
    pub dt: Vec<f32>,
    /// Humidity, 0..1 (0.5 where no biome region says otherwise).
    pub humid: Vec<f32>,
    /// Tree cover chosen by biome regions, 0..1, and how strongly it applies.
    pub forest: Vec<f32>,
    pub forest_w: Vec<f32>,
    /// River curves: [x0, y0, control x, control y, x1, y1, flow at start, flow at end].
    pub curves: Vec<[f32; 8]>,
    // Derived when built or loaded.
    segs: Vec<[f32; 6]>,
    lake_d: Vec<f32>,
    pan_d: Vec<f32>,
    flood_d: Vec<f32>,
    start: Vec<u32>,
    items: Vec<u32>,
}

impl Structure {
    #[allow(clippy::too_many_arguments)]
    pub fn new(w: usize, h: usize, origin: [f32; 2], cell_km: f32, latitude: f32, extent_km: f32, stream_from: f32, fields: [Vec<f32>; FIELDS], curves: Vec<[f32; 8]>) -> Self {
        let [dz, rain, lake, pan, flood, dt, humid, forest, forest_w] = fields;
        let mut s = Self { w, h, origin, cell_km, latitude, extent_km, stream_from, dz, rain, lake, pan, flood, dt, humid, forest, forest_w, curves, segs: Vec::new(), lake_d: Vec::new(), pan_d: Vec::new(), flood_d: Vec::new(), start: Vec::new(), items: Vec::new() };
        s.derive();
        s
    }

    /// Flatten the curves, dilate the water masks by a cell, and index the
    /// river segments by the grid cells they touch.
    fn derive(&mut self) {
        let (w, h) = (self.w, self.h);
        let dilate = |a: &[f32]| -> Vec<f32> {
            let mut out = vec![f32::NAN; a.len()];
            for y in 0..h {
                for x in 0..w {
                    let mut best = f32::NAN;
                    for dy in -1i64..=1 {
                        for dx in -1i64..=1 {
                            let (xx, yy) = (x as i64 + dx, y as i64 + dy);
                            if xx < 0 || yy < 0 || xx >= w as i64 || yy >= h as i64 {
                                continue;
                            }
                            let v = a[yy as usize * w + xx as usize];
                            if !v.is_nan() && (best.is_nan() || v > best) {
                                best = v;
                            }
                        }
                    }
                    out[y * w + x] = best;
                }
            }
            out
        };
        self.lake_d = dilate(&self.lake);
        self.pan_d = dilate(&self.pan);
        self.flood_d = dilate(&self.flood);

        self.segs.clear();
        for c in &self.curves {
            let at = |t: f32| {
                let u = 1.0 - t;
                [u * u * c[0] + 2.0 * u * t * c[2] + t * t * c[4], u * u * c[1] + 2.0 * u * t * c[3] + t * t * c[5]]
            };
            for k in 0..4 {
                let (t0, t1) = (k as f32 / 4.0, (k + 1) as f32 / 4.0);
                let (a, b) = (at(t0), at(t1));
                self.segs.push([a[0], a[1], b[0], b[1], c[6] + (c[7] - c[6]) * t0, c[6] + (c[7] - c[6]) * t1]);
            }
        }
        let cells = w * h;
        let mut counts = vec![0u32; cells + 1];
        let span = |s: &[f32; 6], me: &Self| {
            let (x0, x1) = (s[0].min(s[2]), s[0].max(s[2]));
            let (y0, y1) = (s[1].min(s[3]), s[1].max(s[3]));
            let to = |v: f32, o: f32, n: usize| (((v - o) / me.cell_km).floor() as i64).clamp(0, n as i64 - 1) as usize;
            (to(x0, me.origin[0], w), to(x1, me.origin[0], w), to(y0, me.origin[1], h), to(y1, me.origin[1], h))
        };
        for s in &self.segs {
            let (a, b, c, d) = span(s, self);
            for y in c..=d {
                for x in a..=b {
                    counts[y * w + x + 1] += 1;
                }
            }
        }
        for i in 0..cells {
            counts[i + 1] += counts[i];
        }
        let mut fill = counts.clone();
        let mut items = vec![0u32; counts[cells] as usize];
        for (si, s) in self.segs.iter().enumerate() {
            let (a, b, c, d) = span(s, self);
            for y in c..=d {
                for x in a..=b {
                    let slot = &mut fill[y * w + x];
                    items[*slot as usize] = si as u32;
                    *slot += 1;
                }
            }
        }
        self.start = counts;
        self.items = items;
    }

    /// Flatten to numbers, for sending to a worker.
    pub fn to_f32(&self) -> Vec<f32> {
        let mut out = vec![self.w as f32, self.h as f32, self.origin[0], self.origin[1], self.cell_km, self.latitude, self.extent_km, self.curves.len() as f32, self.stream_from];
        for a in [&self.dz, &self.rain, &self.lake, &self.pan, &self.flood, &self.dt, &self.humid, &self.forest, &self.forest_w] {
            out.extend_from_slice(a);
        }
        for c in &self.curves {
            out.extend_from_slice(c);
        }
        out
    }

    pub fn from_f32(d: &[f32]) -> Option<Structure> {
        if d.len() < HEAD {
            return None;
        }
        let (w, h, n) = (d[0] as usize, d[1] as usize, d[7] as usize);
        let cells = w.checked_mul(h)?;
        if w == 0 || h == 0 || d.len() != HEAD + cells * FIELDS + n * 8 {
            return None;
        }
        let arr = |k: usize| d[HEAD + k * cells..HEAD + (k + 1) * cells].to_vec();
        let curves = d[HEAD + FIELDS * cells..].chunks_exact(8).map(|c| [c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]).collect();
        Some(Structure::new(w, h, [d[2], d[3]], d[4], d[5], d[6], d[8], std::array::from_fn(arr), curves))
    }

    /// Bilinear sample of a grid field at a world position.
    fn bilerp(&self, a: &[f32], p: [f32; 2]) -> f32 {
        let gx = (p[0] - self.origin[0]) / self.cell_km - 0.5;
        let gy = (p[1] - self.origin[1]) / self.cell_km - 0.5;
        let (x0, y0) = (gx.floor(), gy.floor());
        let (fx, fy) = (gx - x0, gy - y0);
        let at = |x: f32, y: f32| a[(y as i64).clamp(0, self.h as i64 - 1) as usize * self.w + (x as i64).clamp(0, self.w as i64 - 1) as usize];
        let top = at(x0, y0) * (1.0 - fx) + at(x0 + 1.0, y0) * fx;
        let bottom = at(x0, y0 + 1.0) * (1.0 - fx) + at(x0 + 1.0, y0 + 1.0) * fx;
        top * (1.0 - fy) + bottom * fy
    }

    /// Smooth (cubic B-spline) sample of a grid field: no creases along the
    /// grid's lines, however far the picture is zoomed in.
    fn smooth(&self, a: &[f32], p: [f32; 2]) -> f32 {
        let gx = (p[0] - self.origin[0]) / self.cell_km - 0.5;
        let gy = (p[1] - self.origin[1]) / self.cell_km - 0.5;
        let (x0, y0) = (gx.floor(), gy.floor());
        let weights = |t: f32| {
            let u = 1.0 - t;
            [u * u * u / 6.0, (3.0 * t * t * t - 6.0 * t * t + 4.0) / 6.0, (-3.0 * t * t * t + 3.0 * t * t + 3.0 * t + 1.0) / 6.0, t * t * t / 6.0]
        };
        let (wx, wy) = (weights(gx - x0), weights(gy - y0));
        let mut sum = 0.0;
        for (j, wj) in wy.iter().enumerate() {
            let y = (y0 as i64 + j as i64 - 1).clamp(0, self.h as i64 - 1) as usize;
            for (i, wi) in wx.iter().enumerate() {
                let x = (x0 as i64 + i as i64 - 1).clamp(0, self.w as i64 - 1) as usize;
                sum += wi * wj * a[y * self.w + x];
            }
        }
        sum
    }

    fn nearest(&self, a: &[f32], p: [f32; 2]) -> f32 {
        let x = (((p[0] - self.origin[0]) / self.cell_km).floor() as i64).clamp(0, self.w as i64 - 1) as usize;
        let y = (((p[1] - self.origin[1]) / self.cell_km).floor() as i64).clamp(0, self.h as i64 - 1) as usize;
        a[y * self.w + x]
    }

    /// Distance (km) to the nearest river and its flow (m³/s) there, and how
    /// far up the hillside the place is (0 in the bed of a big river, 1 on a
    /// crest). Small streams cut shallower gullies than big ones, so each
    /// stream is scored by distance plus a handicap for its size and the
    /// lowest score wins: that keeps the ground continuous where the nearest
    /// stream changes.
    fn nearest_river(&self, p: [f32; 2]) -> Option<(f32, f32, f32)> {
        if self.items.is_empty() {
            return None;
        }
        let cx = ((p[0] - self.origin[0]) / self.cell_km).floor() as i64;
        let cy = ((p[1] - self.origin[1]) / self.cell_km).floor() as i64;
        let mut best = (f32::MAX, 0.0f32);
        let mut up = 1.0f32;
        let reach = 0.8 * self.cell_km;
        for dy in -1..=1 {
            for dx in -1..=1 {
                let (x, y) = (cx + dx, cy + dy);
                if x < 0 || y < 0 || x >= self.w as i64 || y >= self.h as i64 {
                    continue;
                }
                let c = y as usize * self.w + x as usize;
                for &si in &self.items[self.start[c] as usize..self.start[c + 1] as usize] {
                    let s = &self.segs[si as usize];
                    let (abx, aby) = (s[2] - s[0], s[3] - s[1]);
                    let len2 = abx * abx + aby * aby;
                    let t = if len2 > 1e-9 { (((p[0] - s[0]) * abx + (p[1] - s[1]) * aby) / len2).clamp(0.0, 1.0) } else { 0.0 };
                    let d = (p[0] - (s[0] + abx * t)).hypot(p[1] - (s[1] + aby * t));
                    let q = s[4] + (s[5] - s[4]) * t;
                    if d < best.0 {
                        best = (d, q);
                    }
                    if d < reach {
                        let u = 1.0 - d / reach;
                        let size = ((q / self.stream_from).max(1.0).log2() / 5.0).min(1.0);
                        up = up.min(1.0 - u * u.sqrt() + 0.75 * (1.0 - size));
                    }
                }
            }
        }
        if best.0 == f32::MAX { None } else { Some((best.0, best.1, up)) }
    }
}

/// Fractal relief added to the ground, stronger on high ground, absent at
/// the shore. Wavelengths run from 24 km down to two pixels.
fn relief(x: f32, y: f32, elev: f32, px: f32) -> f32 {
    let weight = (0.1 + 0.9 * look::smooth(100.0, 2000.0, elev)) * look::smooth(2.0, 40.0, elev);
    if weight <= 0.0 {
        return 0.0;
    }
    let floor = (2.0 * px).max(0.12);
    let (mut sum, mut wl, mut o) = (0.0, 24.0f32, 0u32);
    while wl >= floor && o < 7 {
        let ridge = 1.0 - gradient(x / wl, y / wl, 77 + o).abs();
        sum += wl * 0.012 * (ridge * ridge - 0.35);
        wl *= 0.5;
        o += 1;
    }
    sum * weight
}

/// Render rows of a window. `e` is an engine window that is `rows + 2 * halo`
/// tall (the extra rows give hillshade and occlusion their neighbours), with
/// the same width as the output. Returns RGBA for the `rows` rows in the middle.
pub fn render_fine(e: &Engine, s: &Structure, style: Style, rows: usize, halo: usize) -> Vec<u8> {
    render_fine_full(e, s, style, rows, halo).0
}

/// How much the hillsides rise away from the streams that drain them (m).
/// Water cuts the valleys, so the ground between two streams is a ridge: the
/// crests, spurs and gullies of a mountainside are the pattern of its
/// drainage. `up` says how far up the slope the place is (see
/// `Structure::nearest_river`): V-shaped at the stream, rounding off towards
/// the crest.
fn hillside(up: f32, elev: f32, s: &Structure) -> f32 {
    let rugged = (0.04 + 0.96 * look::smooth(150.0, 1800.0, elev)) * look::smooth(2.0, 40.0, elev);
    rugged * 50.0 * s.cell_km * (up - 0.45)
}

/// As `render_fine`, and also the height (m) of the ground at each pixel
/// (under any water standing on it), for heightmaps.
pub fn render_fine_full(e: &Engine, s: &Structure, style: Style, rows: usize, halo: usize) -> (Vec<u8>, Vec<f32>) {
    let (w, hh) = (e.width() as usize, e.height() as usize);
    assert_eq!(hh, rows + 2 * halo, "the engine window must include the halo");
    let cell = e.cell_km();
    let [ox, oy] = e.origin();
    let n = w * hh;

    // Pass 1: what each pixel is, and how high.
    #[derive(Clone, Copy, PartialEq)]
    enum Kind { Land, Sea, Lake }
    let mut kind = vec![Kind::Land; n];
    let mut seen = vec![0.0f32; n]; // height as seen from above: ground, or the water's surface
    let mut depth = vec![0.0f32; n];
    let mut pan = vec![false; n];
    let mut stream = vec![(f32::MAX, 0.0f32, 1.0f32); n];
    for y in 0..hh {
        for x in 0..w {
            let i = y * w + x;
            let p = [ox + (x as f32 + 0.5) * cell, oy + (y as f32 + 0.5) * cell];
            // Rivers wander: look them up through a gentle warp of the position.
            let by = wander(p, s.cell_km);
            let wp = [p[0] + by[0], p[1] + by[1]];
            if let Some(r) = s.nearest_river(wp) {
                stream[i] = r;
            }
            let (k, ground, surface) = (e.water()[i], e.elevation()[i], e.surface()[i]);
            match k {
                OCEAN | LAKE | POOL => {
                    kind[i] = if k == OCEAN { Kind::Sea } else { Kind::Lake };
                    seen[i] = surface;
                    depth[i] = (surface - ground).max(0.0);
                }
                _ => {
                    // Land. A cell the live map flooded counts as land here
                    // (flooding comes from the structure, which sees the whole
                    // map), and so does a drawn river: its channel and valley
                    // come from the structure too, on the uncut ground.
                    let mut z = e.ground()[i] + s.smooth(&s.dz, p);
                    z += relief(p[0], p[1], z, cell);
                    z += hillside(stream[i].2, z, s);
                    let lake = s.nearest(&s.lake_d, p);
                    let flood = s.nearest(&s.flood_d, p);
                    let dry = s.nearest(&s.pan_d, p);
                    if !lake.is_nan() && z < lake {
                        kind[i] = Kind::Lake;
                        seen[i] = lake;
                        depth[i] = lake - z;
                    } else if !flood.is_nan() && z < flood {
                        kind[i] = if flood > 0.5 { Kind::Lake } else { Kind::Sea };
                        seen[i] = flood;
                        depth[i] = flood - z;
                    } else {
                        seen[i] = z;
                        pan[i] = !dry.is_nan() && z < dry;
                    }
                }
            }
        }
    }

    // Pass 2: colour the middle rows.
    let mut rgba = vec![0u8; w * rows * 4];
    let cell_m = cell * 1000.0;
    let at = |x: i64, y: i64| seen[(y.clamp(0, hh as i64 - 1) as usize) * w + x.clamp(0, w as i64 - 1) as usize];
    let light = {
        let (lx, ly, lz) = (-1.0f32, -1.0f32, 1.414f32);
        let len = (lx * lx + ly * ly + lz * lz).sqrt();
        [lx / len, ly / len, lz / len]
    };
    const R: i64 = 2;
    for row in 0..rows {
        let y = row + halo;
        for x in 0..w {
            let i = y * w + x;
            let (xi, yi) = (x as i64, y as i64);
            let p = [ox + (x as f32 + 0.5) * cell, oy + (y as f32 + 0.5) * cell];
            let (rd, rq, _) = stream[i];
            let colour = match kind[i] {
                Kind::Sea | Kind::Lake => {
                    // Sediment fans out from where a big river meets the sea.
                    let plume = if kind[i] == Kind::Sea && rd < f32::MAX {
                        (1.0 - rd / (2.0 + 0.03 * rq.sqrt())).max(0.0) * look::smooth(5.0, 300.0, rq)
                    } else {
                        0.0
                    };
                    look::water(depth[i], kind[i] == Kind::Lake, plume, style)
                }
                Kind::Land => {
                    let (sx, sy) = ((at(xi + 1, yi) - at(xi - 1, yi)) / (2.0 * cell_m), (at(xi, yi + 1) - at(xi, yi - 1)) / (2.0 * cell_m));
                    let slope = sx.hypot(sy);
                    let (hx, hy) = (sx * 4.0, sy * 4.0);
                    let lit = (-hx * light[0] - hy * light[1] + light[2]) / (hx * hx + hy * hy + 1.0).sqrt();
                    let ring = (at(xi + R, yi) + at(xi - R, yi) + at(xi, yi + R) + at(xi, yi - R) + at(xi + R, yi + R) + at(xi - R, yi - R) + at(xi + R, yi - R) + at(xi - R, yi + R)) / 8.0;
                    let ao = 1.0 - ((ring - seen[i]) / (R as f32 * cell_m) * 1.2).clamp(0.0, 0.5);
                    let lat = (s.latitude - (p[1] - s.extent_km / 2.0) / 111.32).clamp(-89.0, 89.0);
                    let temp = sea_level_temperature(lat) - 6.5 * seen[i].max(0.0) / 1000.0 + s.bilerp(&s.dt, p);
                    // Green banks along rivers, stronger for big ones.
                    let half = 0.5 * 0.0025 * rq.sqrt();
                    let wet = if rd < f32::MAX { (rq + 1.0).log10().min(3.2) / 3.2 * (-rd / (0.3 + 3.0 * half)).exp() } else { 0.0 };
                    let g = Ground { x: p[0], y: p[1], elev: seen[i], slope, temp, rain: s.bilerp(&s.rain, p), wet, shore: e.shore()[i], pan: pan[i], light: (lit / light[2]).clamp(0.0, 1.6), ao, humid: s.bilerp(&s.humid, p), forest: s.bilerp(&s.forest, p), forest_w: s.bilerp(&s.forest_w, p) };
                    let mut c = look::land(&g, cell, style);
                    // The river itself, at its true width (drawn up to twice as wide
                    // so small ones still read), faint when under a pixel wide.
                    if rd < f32::MAX {
                        let half = half * 2.0;
                        let alpha = if half >= cell { ((half + 0.5 * cell - rd) / cell).clamp(0.0, 1.0) } else { (2.0 * half / cell).min(1.0) * (1.0 - rd / (0.75 * cell)).clamp(0.0, 1.0) };
                        // Larger rivers stay visible as a thin line however fine the pixels.
                        let floor = 0.5 * look::smooth(15.0, 300.0, rq) * (1.0 - rd / (0.8 * cell)).clamp(0.0, 1.0);
                        c = look::lerp3(c, look::river(rq, style), alpha.max(floor));
                    }
                    c
                }
            };
            let o = (row * w + x) * 4;
            rgba[o] = colour[0].clamp(0.0, 255.0) as u8;
            rgba[o + 1] = colour[1].clamp(0.0, 255.0) as u8;
            rgba[o + 2] = colour[2].clamp(0.0, 255.0) as u8;
            rgba[o + 3] = 255;
        }
    }
    // Heights for a heightmap: the ground, under any water too.
    let ground: Vec<f32> = (halo * w..(halo + rows) * w).map(|i| seen[i] - depth[i]).collect();
    (rgba, ground)
}
