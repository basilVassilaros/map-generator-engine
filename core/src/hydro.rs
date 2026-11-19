//! The terrain render: climate, drainage, erosion, lakes, rivers and biomes.
//!
//! This is the slow, whole-map pass run on request, on top of the live map:
//!
//! 1. **Climate.** Temperature falls from the equator to the poles and with
//!    height (6.5 °C per km). Prevailing winds follow the planet's circulation
//!    cells: easterly trade winds within 30° of the equator, westerlies from
//!    30° to 60°, polar easterlies beyond. Air picks up moisture over water
//!    and loses it over land, fastest where it is forced up a slope; once over
//!    the crest it descends dry, leaving a rain shadow. A band of dry,
//!    sinking air sits near 30°, where the world's great deserts are.
//! 2. **Drainage.** Hollows are filled to their spill points so every cell
//!    has a downhill route to the sea ("priority flood"), and rain is
//!    accumulated down those routes into a discharge for every cell.
//! 3. **Erosion.** Valleys are cut with the stream power law: incision grows
//!    with discharge and slope, so big rivers carve long, gentle valleys and
//!    small streams leave steep headwaters. Repeated, the drainage network
//!    organises itself from the mountains down to the coast.
//! 4. **Lakes and rivers.** Hollows that remain hold lakes, filled to the
//!    level where they spill. Evaporation is taken from the water passing
//!    through them, so lakes in dry country have no outflow. Cells carrying
//!    enough water are rivers.
//! 5. **Biomes.** Each land cell is coloured from its temperature and
//!    rainfall, after Whittaker's biome diagram. Biome regions painted by the
//!    user replace the climate inside them.
//!
//! Before the ground is shaped, the render *plans* it as vectors (`plan`):
//! drawn rivers become meandering channels that gather the drainage around
//! them, the divides between rivers become lines of hills, and the rivers and
//! lakes that result are traced as lines and outlines. The terrain is built
//! from those, and the app can show them or keep them as guides.
//!
//! Everything here runs on the CPU with fixed arithmetic, so the same project
//! renders identically on every machine.

use std::cmp::Ordering;
use std::collections::BinaryHeap;

use crate::engine::{Engine, FLOODED, LAKE, LAND, OCEAN, RIVER};
use crate::features::nearest_on_path;
use crate::plan::{self, GenHill, Generated, Grid};
use crate::fine::Structure;
use crate::look::{self, Ground, Style};
use crate::noise::gradient;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Climate {
    /// Average rainfall over the map's land, mm per year.
    pub rainfall_mm: f32,
    /// Evaporation from open water, mm per year.
    pub evaporation_mm: f32,
    /// Latitude of the map's centre, degrees (north positive).
    pub latitude: f32,
    /// How many rounds of valley cutting to run (0 = none).
    pub erosion_rounds: u32,
}

impl Default for Climate {
    fn default() -> Self {
        Self { rainfall_mm: 800.0, evaporation_mm: 900.0, latitude: 35.0, erosion_rounds: 10 }
    }
}

pub struct Rendered {
    pub rgba: Vec<u8>,
    pub elevation: Vec<f32>,
    /// Mean annual temperature (°C) and rainfall (mm) per cell.
    pub temperature: Vec<f32>,
    pub rainfall: Vec<f32>,
    /// Discharge (m³/s) through each cell.
    pub discharge: Vec<f32>,
    /// Water surface height for lake cells that formed in hollows, else NaN.
    pub lake_level: Vec<f32>,
    /// What stage B needs to render any window of this map in fine detail.
    pub structure: Structure,
    /// The rivers, hills and lakes the render planned, as vectors.
    pub generated: Generated,
    pub lake_cells: u32,
    pub river_cells: u32,
}

#[derive(PartialEq)]
struct Node(f32, u32);
impl Eq for Node {}
impl Ord for Node {
    // Lowest height first; ties by index so the order never depends on chance.
    fn cmp(&self, o: &Self) -> Ordering {
        o.0.total_cmp(&self.0).then(o.1.cmp(&self.1))
    }
}
impl PartialOrd for Node {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

const NEIGHBOURS: [(i32, i32, f32); 8] = [
    (1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0),
    (1, 1, std::f32::consts::SQRT_2), (-1, 1, std::f32::consts::SQRT_2),
    (1, -1, std::f32::consts::SQRT_2), (-1, -1, std::f32::consts::SQRT_2),
];

/// Where the water goes. `fixed[i]` marks cells that already are water (their
/// height in `z` is the water surface): the outlets everything drains to,
/// along with the map's edge.
pub struct Routing {
    /// Ground height with every hollow filled to its spill point.
    pub filled: Vec<f32>,
    /// The cell each cell drains into (itself for an outlet).
    pub receiver: Vec<u32>,
    /// Distance to the receiver, in cells.
    pub step: Vec<f32>,
    /// Cells from lowest to highest along the filled surface.
    pub order: Vec<u32>,
}

/// Priority flood: grow inland from the outlets, always from the lowest cell
/// reached so far, raising anything lower than the way in. Every cell ends
/// up with a route that never climbs.
pub fn route(z: &[f32], fixed: &[bool], w: usize, h: usize) -> Routing {
    let n = w * h;
    let mut filled = z.to_vec();
    let mut receiver: Vec<u32> = (0..n as u32).collect();
    let mut step = vec![1.0f32; n];
    let mut order = Vec::with_capacity(n);
    let mut seen = vec![false; n];
    let mut heap = BinaryHeap::with_capacity(n / 4);
    for i in 0..n {
        let (x, y) = (i % w, i / w);
        if fixed[i] || x == 0 || y == 0 || x == w - 1 || y == h - 1 {
            seen[i] = true;
            heap.push(Node(z[i], i as u32));
        }
    }
    while let Some(Node(level, i)) = heap.pop() {
        order.push(i);
        let (x, y) = ((i as usize % w) as i32, (i as usize / w) as i32);
        for (dx, dy, dist) in NEIGHBOURS {
            let (nx, ny) = (x + dx, y + dy);
            if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                continue;
            }
            let j = ny as usize * w + nx as usize;
            if seen[j] {
                continue;
            }
            seen[j] = true;
            // A tiny rise keeps water moving across filled, flat ground.
            filled[j] = z[j].max(level + 1e-3 * dist);
            receiver[j] = i;
            step[j] = dist;
            heap.push(Node(filled[j], j as u32));
        }
    }
    Routing { filled, receiver, step, order }
}

/// Mean annual temperature at sea level for a latitude (degrees).
pub fn sea_level_temperature(latitude: f32) -> f32 {
    -20.0 + 47.0 * latitude.to_radians().cos().max(0.0).powf(1.5)
}

/// How rainy a latitude is, from the circulation cells: wet where air rises
/// (the equator, and around 50 to 60°), dry where it sinks (near 30° and the poles).
fn latitude_wetness(latitude: f32) -> f32 {
    let a = latitude.abs();
    0.3 + 0.7 * (-(a / 12.0).powi(2)).exp() + 0.45 * (-((a - 52.0) / 14.0).powi(2)).exp()
}

/// +1 if the prevailing wind blows towards the east (a westerly), -1 if
/// towards the west (trade winds and polar easterlies).
pub fn wind_direction(latitude: f32) -> i32 {
    let a = latitude.abs();
    if (30.0..60.0).contains(&a) { 1 } else { -1 }
}

/// Average over a square of the given radius (two passes: rows, then columns).
fn box_blur(v: &[f32], w: usize, h: usize, radius: i32) -> Vec<f32> {
    let mut rows = vec![0.0f32; v.len()];
    for y in 0..h {
        for x in 0..w {
            let (a, b) = ((x as i32 - radius).max(0) as usize, (x as i32 + radius).min(w as i32 - 1) as usize);
            rows[y * w + x] = v[y * w + a..=y * w + b].iter().sum::<f32>() / (b - a + 1) as f32;
        }
    }
    let mut out = vec![0.0f32; v.len()];
    for x in 0..w {
        // Running sum down each column.
        let mut sum = 0.0;
        let mut count = 0;
        for y in 0..(radius as usize).min(h) {
            sum += rows[y * w + x];
            count += 1;
        }
        for y in 0..h {
            let enter = y + radius as usize;
            if enter < h {
                sum += rows[enter * w + x];
                count += 1;
            }
            if y as i32 - radius - 1 >= 0 {
                sum -= rows[(y - radius as usize - 1) * w + x];
                count -= 1;
            }
            out[y * w + x] = sum / count as f32;
        }
    }
    out
}

/// Temperature (°C) and rainfall (mm/yr) for every cell.
pub fn climate(z: &[f32], wet: &[bool], w: usize, h: usize, cell_km: f32, map_top_km: f32, map_height_km: f32, c: &Climate) -> (Vec<f32>, Vec<f32>) {
    let n = w * h;
    let mut temperature = vec![0.0f32; n];
    let mut rain = vec![0.0f32; n];
    // Rain responds to the broad shape of the land, not to every bump: winds
    // rise over a range as a whole. Smooth the ground first (about 25 km).
    let smooth_r = ((25.0 / cell_km).round() as i32).clamp(1, 16);
    // (Water counts at its surface height, so air crossing a high lake
    // isn't treated as dropping to sea level and climbing back.)
    let ground: Vec<f32> = z.iter().map(|e| e.max(0.0)).collect();
    let smooth = box_blur(&ground, w, h, smooth_r);

    // Moisture regained per cell over water; lost per cell over flat land;
    // and partly returned by evaporation from the land itself, which is what
    // lets rain reach the interiors of continents.
    let recharge = 1.0 - (-cell_km / 250.0).exp();
    let drizzle = 1.0 - (-cell_km / 450.0).exp();
    let recycle = 1.0 - (-cell_km / 500.0).exp();
    let lee_fade = (-cell_km / 350.0).exp();
    for y in 0..h {
        // North is up: rows further down the map are further south.
        let km_from_centre = map_top_km + (y as f32 + 0.5) * cell_km - map_height_km / 2.0;
        let latitude = (c.latitude - km_from_centre / 111.32).clamp(-89.0, 89.0);
        let sea_t = sea_level_temperature(latitude);
        let wetness = latitude_wetness(latitude);
        let dir = wind_direction(latitude);
        // Warm air holds more water, so warm seas feed more rain.
        let capacity = (0.35 + 0.65 * ((sea_t + 5.0) / 32.0).clamp(0.0, 1.0)) * wetness;
        let mut moisture = 1.0f32; // air arriving at the map's edge comes off the sea
        let mut lee = 0.0f32; // how deep in a rain shadow the air is
        let mut previous = 0.0f32;
        for k in 0..w {
            let x = if dir > 0 { k } else { w - 1 - k };
            let i = y * w + x;
            temperature[i] = sea_t - 6.5 * z[i].max(0.0) / 1000.0;
            if wet[i] {
                moisture += (1.0 - moisture) * recharge;
                lee *= lee_fade;
                previous = smooth[i];
                continue;
            }
            let climb = (smooth[i] - previous) / 1000.0; // km gained since the last cell
            previous = smooth[i];
            let mut share = drizzle;
            if climb > 0.0 {
                // Forced up the slope, the air cools and its water falls out:
                // about a third of what it holds for each kilometre climbed.
                share += (climb * 0.28).min(0.9);
            } else {
                // Sinking air warms and dries: the rain shadow.
                lee = lee.max((-climb * 3.0).min(1.0));
            }
            share *= 1.0 - 0.85 * lee;
            lee *= lee_fade;
            let fallen = moisture * share.min(1.0);
            moisture -= fallen;
            moisture += (0.55 - moisture).max(0.0) * recycle;
            rain[i] = fallen / cell_km * capacity;
        }
    }
    // Winds are not perfectly steady from due west or east, so spread the
    // rain a little in both directions rather than leaving it in stripes.
    let spread = ((30.0 / cell_km).round() as i32).clamp(1, 16);
    let mut blurred = box_blur(&rain, w, h, spread);
    // Scale so the land's average matches the chosen rainfall.
    let (mut total, mut land) = (0.0f64, 0u32);
    for i in 0..n {
        if !wet[i] {
            total += blurred[i] as f64;
            land += 1;
        }
    }
    let scale = if total > 0.0 { c.rainfall_mm as f64 * land as f64 / total } else { 0.0 };
    for i in 0..n {
        blurred[i] = if wet[i] { 0.0 } else { (blurred[i] as f64 * scale) as f32 };
    }
    (temperature, blurred)
}

/// Discharge (m³/s) through every cell: rain gathered along the drainage
/// routes, less evaporation from any standing water it passes through.
fn discharge(r: &Routing, z: &[f32], rain: &[f32], inflow: &[f32], cell_km: f32, evaporation_mm: f32) -> Vec<f32> {
    // mm/yr over one cell, as m³/s.
    let per_mm = cell_km * cell_km * 1e3 / 3.156e7;
    let mut q: Vec<f32> = rain.iter().zip(inflow).map(|(p, extra)| p * per_mm + extra).collect();
    for &i in r.order.iter().rev() {
        let i = i as usize;
        if r.filled[i] - z[i] > 0.5 {
            q[i] = (q[i] - evaporation_mm * per_mm).max(0.0);
        }
        let to = r.receiver[i] as usize;
        if to != i {
            q[to] += q[i];
        }
    }
    q
}

/// Curves for the drainage network: each river cell's channel runs from the
/// midpoint of the edge with the cell upstream, bending through the cell's
/// centre, to the midpoint of the edge downstream. Joined end to end these
/// make smooth curves, and tributaries merge into them.
fn stream_curves(r: &Routing, q: &[f32], fixed: &[bool], drawn: &[DrawnRiver], on_drawn: &[u32], w: usize, h: usize, cell_km: f32, origin: [f32; 2], q_min: f32) -> Vec<[f32; 8]> {
    let n = w * h;
    let centre = |i: usize| [origin[0] + ((i % w) as f32 + 0.5) * cell_km, origin[1] + ((i / w) as f32 + 0.5) * cell_km];
    let mid = |a: [f32; 2], b: [f32; 2]| [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
    let mut curves = Vec::new();
    let mut has_donor = vec![false; n];
    for d in 0..n {
        let i = r.receiver[d] as usize;
        if fixed[d] || q[d] < q_min || i == d || fixed[i] {
            continue;
        }
        has_donor[i] = true;
        let to = r.receiver[i] as usize;
        if on_drawn[i] != 0 {
            // The receiver is a drawn river, which has its own line: a stream
            // arriving from the side runs on to meet that line.
            if on_drawn[d] == 0 {
                let start = mid(centre(d), centre(i));
                let line = &drawn[on_drawn[i] as usize - 1].line;
                let end = closest_point(start, line);
                let m = mid(start, end);
                curves.push([start[0], start[1], m[0], m[1], end[0], end[1], q[d], q[d]]);
            }
            continue;
        }
        if to == i {
            continue;
        }
        let (pc, pd) = (centre(i), centre(d));
        let end = mid(pc, centre(to));
        let start = mid(pd, pc);
        curves.push([start[0], start[1], pc[0], pc[1], end[0], end[1], q[d], q[i]]);
    }
    for i in 0..n {
        let to = r.receiver[i] as usize;
        if fixed[i] || q[i] < q_min || has_donor[i] || to == i || on_drawn[i] != 0 {
            continue;
        }
        let (pc, end) = (centre(i), mid(centre(i), centre(to)));
        let m = mid(pc, end);
        curves.push([pc[0], pc[1], m[0], m[1], end[0], end[1], q[i], q[i]]);
    }
    // The drawn rivers themselves, along their own (meandering) lines.
    for river in drawn {
        let cell_of = |p: [f32; 2]| {
            let (x, y) = (((p[0] - origin[0]) / cell_km).floor() as i64, ((p[1] - origin[1]) / cell_km).floor() as i64);
            (x >= 0 && y >= 0 && x < w as i64 && y < h as i64).then(|| y as usize * w + x as usize)
        };
        // Flow only grows on the way down (the line clips corners of cells
        // the water itself goes round).
        let mut flow = 0.0f32;
        for s in river.line.windows(2) {
            let before = flow;
            if let Some(i) = cell_of(s[1]).filter(|i| !fixed[*i]) {
                flow = flow.max(q[i]);
            }
            if before <= 0.0 {
                continue;
            }
            let m = mid(s[0], s[1]);
            curves.push([s[0][0], s[0][1], m[0], m[1], s[1][0], s[1][1], before, flow]);
        }
        // Past the end of the drawn line the water carries on downhill.
        if let (Some(&last), Some(&end)) = (river.cells.last(), river.line.last()) {
            let to = r.receiver[last] as usize;
            if to != last && !fixed[to] && on_drawn[to] == 0 {
                let exit = mid(centre(last), centre(to));
                let m = mid(end, exit);
                curves.push([end[0], end[1], m[0], m[1], exit[0], exit[1], q[last], q[last]]);
            }
        }
    }
    curves
}

fn closest_point(p: [f32; 2], line: &[[f32; 2]]) -> [f32; 2] {
    let mut best = (f32::MAX, p);
    for s in line.windows(2) {
        let (a, b) = (s[0], s[1]);
        let (abx, aby) = (b[0] - a[0], b[1] - a[1]);
        let len2 = abx * abx + aby * aby;
        let t = if len2 > 1e-9 { (((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2).clamp(0.0, 1.0) } else { 0.0 };
        let c = [a[0] + abx * t, a[1] + aby * t];
        let d = (p[0] - c[0]).hypot(p[1] - c[1]);
        if d < best.0 {
            best = (d, c);
        }
    }
    best.1
}

/// A river the user drew, as the terrain render uses it.
pub struct DrawnRiver {
    /// The channel from source to mouth: the drawn curve with meanders added,
    /// ending where it reaches standing water.
    pub line: Vec<[f32; 2]>,
    /// The grid cells the channel passes through, in order.
    pub cells: Vec<usize>,
    /// Flow (m³/s) the river carries at its mouth besides what drains into it.
    pub flow: f32,
}

/// Turn a drawn river into a natural channel. Real rivers swing from side to
/// side: broad loops with smaller wiggles on them, fading out at the source
/// and the mouth so the river still starts and ends where it was drawn.
fn drawn_river(e: &Engine, river: &crate::features::River, fixed: &[bool]) -> Option<DrawnRiver> {
    let path = &river.path;
    if path.len() < 2 {
        return None;
    }
    let cell = e.cell_km();
    let total: f32 = path.windows(2).map(|s| (s[1][0] - s[0][0]).hypot(s[1][1] - s[0][1])).sum();
    // Fine enough to draw smooth bends, whatever the grid.
    let step = (cell * 0.5).min(0.4).max(total / 6000.0);
    let mut even: Vec<[f32; 2]> = vec![path[0]];
    let mut carried = 0.0;
    for s in path.windows(2) {
        let (a, b) = (s[0], s[1]);
        let len = (b[0] - a[0]).hypot(b[1] - a[1]);
        let mut at = step - carried;
        while at <= len {
            let t = at / len;
            even.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
            at += step;
        }
        carried = len - (at - step);
    }
    let n = even.len();
    if n < 3 {
        return None;
    }
    let length = (n - 1) as f32 * step;
    // Meanders are about a dozen channel widths long, on top of broader swings.
    let bend = (12.0 * river.width_km).clamp(1.2, 8.0).min(length / 6.0);
    let swing = (5.0 * bend).min(length / 3.0);
    let seed = 0x52b0u32.wrapping_add(river.id.wrapping_mul(0x9e37));
    // Direction of travel, taken over a few km so the bends don't feed back on it.
    let span = ((1.5 / step).round() as usize).max(1);
    let line: Vec<[f32; 2]> = (0..n)
        .map(|k| {
            let (a, b) = (even[k.saturating_sub(span)], even[(k + span).min(n - 1)]);
            let len = (b[0] - a[0]).hypot(b[1] - a[1]).max(1e-6);
            let normal = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
            let s = k as f32 * step;
            let fade = look::smooth(0.0, (0.12 * length).min(3.0 * bend), s.min(length - s));
            // Uneven loops: the rhythm drifts and some bends are tighter than others.
            let phase = std::f32::consts::TAU * s / bend + 2.5 * gradient(s / (3.0 * bend), 1.7, seed ^ 0x21);
            let size = 0.55 + 0.45 * gradient(s / (4.0 * bend), 5.3, seed ^ 0x43);
            let off = fade * (0.2 * bend * size * (0.7 * phase.sin() + 0.5 * (0.61 * phase + 4.0 * gradient(s / (5.0 * bend), 9.1, seed ^ 0x77)).sin()) + 0.5 * swing * 0.22 * gradient(s / swing, 0.37, seed));
            [even[k][0] + normal[0] * off, even[k][1] + normal[1] * off]
        })
        .collect();
    // Follow the line until it reaches standing water (after leaving any it started in).
    let mut cells: Vec<usize> = Vec::new();
    let mut kept: Vec<[f32; 2]> = Vec::new();
    for p in &line {
        let Some(i) = e.cell_at(*p) else {
            if cells.is_empty() { continue } else { break }
        };
        if fixed[i] {
            if cells.is_empty() {
                continue;
            }
            kept.push(*p);
            break;
        }
        kept.push(*p);
        if cells.last() != Some(&i) {
            cells.push(i);
        }
    }
    if cells.len() < 2 {
        return None;
    }
    // The river's own flow, from the width it was drawn with (the picture
    // shows a river about 0.01 km wide for each unit of the square root of its flow).
    let flow = (river.width_km / 0.01).powi(2).clamp(8.0, 20000.0);
    Some(DrawnRiver { line: kept, cells, flow })
}

/// Run stage A of the terrain render on an engine's current map: climate,
/// drainage, valley cutting, lakes and rivers, coloured in `style`.
pub fn render(e: &Engine, c: &Climate, style: Style) -> Rendered {
    let (w, h) = (e.width() as usize, e.height() as usize);
    let n = w * h;
    let cell_km = e.cell_km();
    let kinds = e.water();
    let grid = Grid { w, h, cell_km, origin: e.origin() };
    // Drawn rivers are not fixed water here: they are channels in the land,
    // shaped below, that the drainage runs through. Pools, lakes and seas are.
    let fixed: Vec<bool> = kinds.iter().map(|k| *k != LAND && *k != RIVER).collect();
    // The ground as the guides give it, before any river was cut into it.
    // Everything stage A adds (undulation, hills, channels, valley cutting)
    // is handed to stage B as `dz`.
    let z0: Vec<f32> = (0..n).map(|i| if fixed[i] { e.surface()[i] } else { e.ground()[i] }).collect();
    // Some unevenness so rivers wander across plains instead of running ruler-
    // straight over a smooth tilt (routing water over a plane gives parallel
    // diagonal lines): fine grain, rolling hills, and broad swells.
    let mut z: Vec<f32> = (0..n)
        .map(|i| {
            if fixed[i] {
                z0[i]
            } else {
                let (x, y) = ((i % w) as f32, (i / w) as f32);
                z0[i] + 1.5 * gradient(x * 0.37, y * 0.37, 0x7e11) + 4.0 * gradient(x * 0.11, y * 0.11, 0x51ab) + 11.0 * gradient(x * 0.05, y * 0.05, 0x3c9d)
            }
        })
        .collect();

    // Drawn rivers: a channel that only ever descends from source to mouth,
    // set into the ground so the country around drains into it.
    let drawn: Vec<DrawnRiver> = e.rivers().iter().filter_map(|r| drawn_river(e, r, &fixed)).collect();
    let mut on_drawn = vec![0u32; n];
    let mut inflow = vec![0.0f32; n];
    for (k, (river, guide)) in drawn.iter().zip(e.rivers().iter().filter(|r| r.path.len() >= 2)).enumerate() {
        let depth = (guide.depth_m * 0.25).max(6.0);
        let mut bed = f32::MAX;
        for &i in &river.cells {
            // Never below sea level on the way down, unless the land already is.
            bed = (bed - 0.02).min((z[i] - depth).max(z[i].min(0.5)));
            z[i] = bed;
            on_drawn[i] = k as u32 + 1;
            inflow[i] += river.flow / river.cells.len() as f32;
        }
    }

    let (mut temperature, mut rainfall) = climate(&z, &fixed, w, h, cell_km, e.origin()[1], h as f32 * cell_km, c);

    // Biome regions: inside each, the climate is what the user chose.
    let mut humid = vec![0.5f32; n];
    let mut forest = vec![0.0f32; n];
    let mut forest_w = vec![0.0f32; n];
    let mut dt = vec![0.0f32; n];
    for region in e.regions() {
        let reach = region.feather_km.max(0.0) * 0.5 + cell_km;
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for p in &region.points {
            (x0, y0, x1, y1) = (x0.min(p[0]), y0.min(p[1]), x1.max(p[0]), y1.max(p[1]));
        }
        let col = |v: f32| (((v - e.origin()[0]) / cell_km).floor().max(0.0) as usize).min(w);
        let row = |v: f32| (((v - e.origin()[1]) / cell_km).floor().max(0.0) as usize).min(h);
        for y in row(y0 - reach)..row(y1 + reach + cell_km) {
            let km_from_centre = e.origin()[1] + (y as f32 + 0.5) * cell_km - h as f32 * cell_km / 2.0;
            let sea_t = sea_level_temperature((c.latitude - km_from_centre / 111.32).clamp(-89.0, 89.0));
            for x in col(x0 - reach)..col(x1 + reach + cell_km) {
                let i = y * w + x;
                let k = region.weight(grid.centre(i));
                if k <= 0.0 {
                    continue;
                }
                if !fixed[i] {
                    rainfall[i] += (region.rainfall_mm.max(0.0) - rainfall[i]) * k;
                }
                humid[i] += (region.humidity.clamp(0.0, 1.0) - humid[i]) * k;
                forest[i] += (region.forest.clamp(0.0, 1.0) - forest[i]) * k;
                forest_w[i] = forest_w[i].max(k);
                if region.temp_c.is_finite() {
                    dt[i] += (region.temp_c - sea_t - dt[i]) * k;
                }
            }
        }
    }
    for i in 0..n {
        temperature[i] += dt[i];
    }

    // Plan the hills. Rain collects into rivers; the ground furthest from any
    // river is the divide between them, and that is where hills stand.
    let river_from = 6.0f32; // m³/s
    let hills: Vec<GenHill> = {
        let r = route(&z, &fixed, w, h);
        let q = discharge(&r, &z, &rainfall, &inflow, cell_km, c.evaporation_mm);
        let mask: Vec<bool> = (0..n).map(|i| fixed[i] || on_drawn[i] != 0 || q[i] >= river_from).collect();
        let land: Vec<bool> = fixed.iter().map(|f| !f).collect();
        plan::find_divides(&grid, &mask, &land, 60)
            .into_iter()
            .filter_map(|(points, far_km)| {
                // Leave alone any divide a drawn mountain already stands on.
                let mid = points[points.len() / 2];
                let taken = e.mountains().iter().any(|m| !m.path.is_empty() && [points[0], mid, points[points.len() - 1]].iter().any(|p| nearest_on_path(*p, &m.path).0 < m.width_km));
                (!taken).then(|| GenHill { points, height: (9.0 * far_km.powf(0.85)).clamp(25.0, 450.0), width_km: (far_km * 0.9).max(2.0 * cell_km) })
            })
            .collect()
    };
    for (k, hill) in hills.iter().enumerate() {
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for p in &hill.points {
            (x0, y0, x1, y1) = (x0.min(p[0]), y0.min(p[1]), x1.max(p[0]), y1.max(p[1]));
        }
        let col = |v: f32| (((v - e.origin()[0]) / cell_km).floor().max(0.0) as usize).min(w);
        let row = |v: f32| (((v - e.origin()[1]) / cell_km).floor().max(0.0) as usize).min(h);
        for y in row(y0 - hill.width_km)..row(y1 + hill.width_km + cell_km) {
            for x in col(x0 - hill.width_km)..col(x1 + hill.width_km + cell_km) {
                let i = y * w + x;
                if fixed[i] || on_drawn[i] != 0 {
                    continue;
                }
                let (d, along) = nearest_on_path(grid.centre(i), &hill.points);
                if d >= hill.width_km {
                    continue;
                }
                // Rounded in profile, with summits and saddles along the crest.
                let t = 1.0 - d / hill.width_km;
                let crest = 0.75 + 0.25 * gradient(along / (2.5 * hill.width_km), k as f32 * 3.1, 0x4111);
                z[i] += hill.height * t * t * (3.0 - 2.0 * t) * crest;
            }
        }
    }

    // Water running down an even slope would cut ruler-straight, parallel
    // gullies. Real slopes are uneven at every scale, which is what gathers
    // streams into branching valleys with spurs between them: roughen the
    // ground in proportion to how steep it is.
    {
        let at = |x: i64, y: i64| z[y.clamp(0, h as i64 - 1) as usize * w + x.clamp(0, w as i64 - 1) as usize];
        let steep: Vec<f32> = (0..n)
            .map(|i| {
                let (x, y) = ((i % w) as i64, (i / w) as i64);
                (0.5 * (at(x + 1, y) - at(x - 1, y))).hypot(0.5 * (at(x, y + 1) - at(x, y - 1)))
            })
            .collect();
        let steep = box_blur(&steep, w, h, 2);
        for i in 0..n {
            if fixed[i] || on_drawn[i] != 0 {
                continue;
            }
            let (x, y) = ((i % w) as f32, (i / w) as f32);
            let rough = 0.35 * gradient(x / 2.3, y / 2.3, 0x1a01) + 0.7 * gradient(x / 5.0, y / 5.0, 0x1a02) + 1.1 * gradient(x / 11.0, y / 11.0, 0x1a03) + 1.4 * gradient(x / 23.0, y / 23.0, 0x1a04);
            z[i] = (z[i] + steep[i].min(400.0) * rough).max(z0[i].min(0.5));
        }
    }

    // Cut valleys. Downstream cells are settled first, so each cell is
    // lowered towards a receiver that has already moved (stable for any rate).
    for _ in 0..c.erosion_rounds {
        let r = route(&z, &fixed, w, h);
        let q = discharge(&r, &z, &rainfall, &inflow, cell_km, c.evaporation_mm);
        for &i in &r.order {
            let i = i as usize;
            let to = r.receiver[i] as usize;
            if fixed[i] || to == i {
                continue;
            }
            // Shallow hollows silt up into flat valley floors; only deep
            // basins stay to hold lakes.
            let hollow = r.filled[i] - z[i];
            if hollow > 0.0 && hollow < 40.0 {
                z[i] = r.filled[i];
            }
            if z[i] <= z[to] {
                continue;
            }
            // Stream power with slope exponent 1: the drop to the receiver
            // shrinks by a factor that grows with the square root of discharge.
            let power = 0.05 * q[i].sqrt() / r.step[i];
            z[i] = z[to] + (z[i] - z[to]) / (1.0 + power);
        }
    }

    let r = route(&z, &fixed, w, h);
    let q = discharge(&r, &z, &rainfall, &inflow, cell_km, c.evaporation_mm);

    // What stage B needs: the height changes, rain, and where water stands.
    let wet_hollow = |i: usize| !fixed[i] && r.filled[i] - z[i] > 2.0 && q[i] > 0.02;
    // A salt pan is a real basin in dry country, not a shallow dip near the coast.
    let dry_hollow = |i: usize| !fixed[i] && r.filled[i] - z[i] > 6.0 && q[i] <= 0.02 && rainfall[i] < 350.0;
    // Streams fine enough to shape the hillsides: any cell gathering the rain
    // of a few cells around it.
    let (mut total, mut land_cells) = (0.0f64, 0u32);
    for i in 0..n {
        if !fixed[i] {
            total += rainfall[i] as f64;
            land_cells += 1;
        }
    }
    let per_cell = (total / land_cells.max(1) as f64) as f32 * cell_km * cell_km * 1e3 / 3.156e7;
    let stream_from = (2.5 * per_cell).clamp(0.01, 1.2);
    let lake: Vec<f32> = (0..n).map(|i| if wet_hollow(i) { r.filled[i] } else { f32::NAN }).collect();
    let generated = Generated {
        rivers: plan::trace_rivers(&grid, &r, &q, &|i| !fixed[i] && on_drawn[i] == 0 && q[i] >= river_from && !wet_hollow(i), 48),
        hills,
        lakes: plan::trace_lakes(&grid, &lake, 24),
    };
    let structure = Structure::new(
        w,
        h,
        e.origin(),
        cell_km,
        c.latitude,
        w as f32 * cell_km,
        stream_from,
        [
            (0..n).map(|i| if fixed[i] { 0.0 } else { z[i] - z0[i] }).collect(),
            rainfall.clone(),
            lake,
            (0..n).map(|i| if dry_hollow(i) { r.filled[i] } else { f32::NAN }).collect(),
            (0..n).map(|i| if kinds[i] == FLOODED { e.surface()[i] } else { f32::NAN }).collect(),
            dt,
            humid.clone(),
            forest.clone(),
            forest_w.clone(),
        ],
        stream_curves(&r, &q, &fixed, &drawn, &on_drawn, w, h, cell_km, e.origin(), stream_from),
    );

    // The picture: lakes where hollows hold water, rivers where enough collects.
    let mut lake_level = vec![f32::NAN; n];
    let (mut lake_cells, mut river_cells) = (0u32, 0u32);
    let mut rgba = vec![0u8; n * 4];
    let light = {
        let (x, y, zc) = (-1.0f32, -1.0f32, 1.414f32);
        let len = (x * x + y * y + zc * zc).sqrt();
        [x / len, y / len, zc / len]
    };
    let seen = |x: i64, y: i64| -> f32 {
        let i = y.clamp(0, h as i64 - 1) as usize * w + x.clamp(0, w as i64 - 1) as usize;
        if fixed[i] { z[i] } else { r.filled[i].max(z[i]) }
    };
    let cell_m = cell_km * 1000.0;
    for i in 0..n {
        let (x, y) = ((i % w) as i64, (i / w) as i64);
        let colour = if fixed[i] {
            // Sea, drawn lakes and pools: by depth below their surface.
            let lake = kinds[i] != OCEAN && (kinds[i] != FLOODED || e.surface()[i] > 0.5);
            look::water((e.surface()[i] - e.elevation()[i]).max(0.0), lake, 0.0, style)
        } else if wet_hollow(i) {
            lake_level[i] = r.filled[i];
            lake_cells += 1;
            look::water(r.filled[i] - z[i], true, 0.0, style)
        } else {
            let (sx, sy) = ((seen(x + 1, y) - seen(x - 1, y)) / (2.0 * cell_m), (seen(x, y + 1) - seen(x, y - 1)) / (2.0 * cell_m));
            let (hx, hy) = (sx * 4.0, sy * 4.0);
            let lit = (-hx * light[0] - hy * light[1] + light[2]) / (hx * hx + hy * hy + 1.0).sqrt();
            let ring = (seen(x + 2, y) + seen(x - 2, y) + seen(x, y + 2) + seen(x, y - 2) + seen(x + 2, y + 2) + seen(x - 2, y - 2) + seen(x + 2, y - 2) + seen(x - 2, y + 2)) / 8.0;
            let ao = 1.0 - ((ring - seen(x, y)) / (2.0 * cell_m) * 1.2).clamp(0.0, 0.5);
            let g = Ground {
                x: (x as f32 + 0.5) * cell_km + e.origin()[0],
                y: (y as f32 + 0.5) * cell_km + e.origin()[1],
                elev: z[i].max(0.0),
                slope: sx.hypot(sy),
                temp: temperature[i],
                rain: rainfall[i],
                wet: look::smooth(0.5, 60.0, q[i]) * 0.8,
                shore: e.shore()[i],
                pan: dry_hollow(i),
                light: (lit / light[2]).clamp(0.0, 1.6),
                ao,
                humid: humid[i],
                forest: forest[i],
                forest_w: forest_w[i],
            };
            let mut colour = look::land(&g, cell_km, style);
            if q[i] >= river_from {
                river_cells += 1;
                // Bigger rivers show more strongly.
                let strength = (0.45 + 0.2 * (q[i] / river_from).log10()).clamp(0.45, 0.95);
                colour = look::lerp3(colour, look::river(q[i], style), strength);
            }
            colour
        };
        rgba[i * 4] = colour[0].clamp(0.0, 255.0) as u8;
        rgba[i * 4 + 1] = colour[1].clamp(0.0, 255.0) as u8;
        rgba[i * 4 + 2] = colour[2].clamp(0.0, 255.0) as u8;
        rgba[i * 4 + 3] = 255;
    }
    let _ = LAKE;
    Rendered { rgba, elevation: z, temperature, rainfall, discharge: q, lake_level, structure, generated, lake_cells, river_cells }
}
