//! The satellite look: turning climate, slope and water into colour.
//!
//! Imagery of the Earth from orbit reads as real because of a handful of
//! effects, all reproduced here per pixel and all driven by data the map
//! already has:
//!
//! * **Land cover** is textured, not flat: forest canopy grain, patchy cover,
//!   dune fields and salt pans in deserts, with density following rainfall
//!   and temperature (Whittaker's biome diagram).
//! * **Slope and altitude** decide bare rock on steep ground, a treeline, and
//!   a ragged snow line that depends on temperature.
//! * **Water** shades from turquoise shallows to deep blue, with sediment
//!   plumes off river mouths, wetlands and green banks along rivers.
//! * **Light** is hillshade plus ambient occlusion, so valleys sit darker,
//!   graded like real sensor imagery (slightly desaturated).
//!
//! Every function depends only on its inputs and the world position, so the
//! same pixel gets the same colour however the map is cut into strips.

use crate::noise::gradient;
use crate::render::tint;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Style {
    /// Natural, slightly muted colour, like Landsat or Sentinel imagery.
    TrueColour,
    /// Saturated and contrasty.
    Vivid,
    /// Elevation tints and hillshade, like a printed atlas.
    Atlas,
}

impl Style {
    pub fn from_u32(v: u32) -> Style {
        match v {
            1 => Style::Vivid,
            2 => Style::Atlas,
            _ => Style::TrueColour,
        }
    }
}

#[inline]
pub fn lerp3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    let t = t.clamp(0.0, 1.0);
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/// Smooth 0..1 step from `e0` to `e1` (either order).
#[inline]
pub fn smooth(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Layered noise, wavelengths from `longest` km down to `shortest`, but never
/// finer than two pixels (`px` km), so it never aliases. Roughly -1..1.
fn band(x: f32, y: f32, longest: f32, shortest: f32, px: f32, seed: u32) -> f32 {
    let floor = shortest.max(2.0 * px);
    let (mut sum, mut amp, mut norm, mut wl) = (0.0, 1.0, 0.0, longest);
    let mut o = 0u32;
    while wl >= floor && o < 8 {
        sum += amp * gradient(x / wl, y / wl, seed.wrapping_add(o.wrapping_mul(0x9e37)));
        norm += amp;
        amp *= 0.55;
        wl *= 0.5;
        o += 1;
    }
    if norm > 0.0 { sum / norm } else { 0.0 }
}

/// Ground colour from temperature and rainfall, after Whittaker's biomes:
/// desert where it's dry, grass and scrub in between, forest where it's wet;
/// tundra where it's cold. Blended rather than banded.
pub fn biome_colour(t: f32, rain_mm: f32) -> [f32; 3] {
    // Below about 250 mm is desert, grassland runs to roughly 750 mm, forest
    // beyond. Warm places need more rain to be as green: more evaporates.
    let forest_at = 700.0 + 25.0 * t.max(0.0);
    let wet = ((rain_mm / forest_at - 0.15) / 0.85).clamp(0.0, 1.0);
    let warmth = ((t + 5.0) / 30.0).clamp(0.0, 1.0);
    let desert = lerp3([150.0, 146.0, 132.0], [214.0, 190.0, 140.0], warmth);
    let grass = lerp3([146.0, 152.0, 110.0], [176.0, 170.0, 96.0], warmth);
    let forest = if t < 3.0 {
        lerp3([120.0, 132.0, 104.0], [62.0, 98.0, 72.0], (t + 6.0) / 9.0) // tundra to boreal forest
    } else if t < 14.0 {
        lerp3([62.0, 98.0, 72.0], [72.0, 122.0, 66.0], (t - 3.0) / 11.0) // boreal to temperate
    } else {
        lerp3([72.0, 122.0, 66.0], [38.0, 100.0, 54.0], (t - 14.0) / 12.0) // temperate to tropical
    };
    let colour = if wet < 0.5 { lerp3(desert, grass, wet * 2.0) } else { lerp3(grass, forest, (wet - 0.5) * 2.0) };
    // Permanent snow and ice where the year's average is well below freezing.
    lerp3(colour, [236.0, 240.0, 244.0], (-2.0 - t) / 8.0)
}

/// What the renderer knows about one patch of dry land.
#[derive(Clone, Copy, Debug)]
pub struct Ground {
    /// World position (km), which anchors the texture.
    pub x: f32,
    pub y: f32,
    /// Height above sea level (m).
    pub elev: f32,
    /// Steepness: rise over run.
    pub slope: f32,
    /// Mean annual temperature (°C) and rainfall (mm).
    pub temp: f32,
    pub rain: f32,
    /// 0..1: how close to fresh water (greens up the banks).
    pub wet: f32,
    /// Distance (km) inland from the coast; negative if not coastal.
    pub shore: f32,
    /// A dried-out lake bed.
    pub pan: bool,
    /// Hillshade (1 = flat) and ambient occlusion (1 = open).
    pub light: f32,
    pub ao: f32,
    /// 0..1: how humid the air is; 0.5 is ordinary. Dry air makes the same
    /// rain go less far for plants.
    pub humid: f32,
    /// Tree cover a biome region asks for (0..1), and how strongly (0 = not
    /// in a region: cover follows the climate).
    pub forest: f32,
    pub forest_w: f32,
}

fn grade(c: [f32; 3], style: Style) -> [f32; 3] {
    let l = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    let (sat, gain, lift) = match style {
        Style::TrueColour => (0.9, 0.96, 6.0),
        Style::Vivid => (1.28, 1.04, 0.0),
        Style::Atlas => (1.0, 1.0, 0.0),
    };
    let sat = |v: f32| (l + (v - l) * sat) * gain + lift;
    [sat(c[0]), sat(c[1]), sat(c[2])]
}

/// Colour of dry land.
pub fn land(g: &Ground, px: f32, style: Style) -> [f32; 3] {
    let shade = 1.0 + (g.light - 1.0) * if style == Style::Atlas { 0.7 } else { 0.8 };
    if style == Style::Atlas {
        let c = tint(g.elev.max(0.5));
        let c = if g.shore >= 0.0 && g.shore < 0.5 + px { lerp3(c, [216.0, 201.0, 154.0], 0.7) } else { c };
        return [c[0] * shade, c[1] * shade, c[2] * shade];
    }
    let eff_rain = g.rain * (1.0 + 2.5 * g.wet) * (0.45 + 1.1 * g.humid.clamp(0.0, 1.0));
    let mut c = biome_colour(g.temp, eff_rain);
    let forest_at = 700.0 + 25.0 * g.temp.max(0.0);
    let mut veg = smooth(0.15, 1.0, eff_rain / forest_at) * smooth(-8.0, 3.0, g.temp);
    // A biome region sets how much of the ground is under trees: woods stand
    // in clumps, and the density says how much the clumps cover.
    if g.forest_w > 0.0 {
        let open = biome_colour(g.temp, eff_rain.min(0.55 * forest_at));
        let canopy = biome_colour(g.temp, 3.0 * forest_at);
        let clump = 0.5 + 0.5 * band(g.x, g.y, 9.0, 0.3, px, 67);
        let cover = g.forest.clamp(0.0, 1.0);
        let patchy = smooth(1.0 - cover - 0.18, 1.0 - cover + 0.18, clump * 0.999 + 0.0005) * smooth(0.0, 0.04, cover);
        // Too coarse to see clumps: show the average.
        let covered = cover + (patchy - cover) * smooth(4.5, 1.5, px);
        let trees = covered * smooth(-9.0, -1.0, g.temp);
        c = lerp3(c, lerp3(open, canopy, trees), g.forest_w);
        veg += (trees.max(0.2 * veg) - veg) * g.forest_w.clamp(0.0, 1.0);
    }

    // Texture: broad patchiness, plus fine canopy grain where it's green.
    let patch = band(g.x, g.y, 70.0, 8.0, px, 11);
    let grain = band(g.x, g.y, 2.5, 0.12, px, 23);
    let mut k = 1.0 + 0.10 * patch + (0.06 + 0.12 * veg) * grain;

    // Hot deserts: dune ripples and sandier patches.
    let arid = smooth(250.0, 60.0, g.rain) * smooth(0.0, 12.0, g.temp);
    if arid > 0.0 {
        c = lerp3(c, [196.0, 160.0, 112.0], arid * 0.35 * (0.5 + 0.5 * patch));
        if px < 2.0 {
            let (u, v) = (g.x * 0.94 + g.y * 0.34, -g.x * 0.34 + g.y * 0.94);
            k += arid * 0.10 * gradient(u / 4.0, v / 0.9, 31);
        }
    }
    // Dried lake beds: pale salt crust.
    if g.pan {
        c = lerp3(c, [228.0, 224.0, 210.0], 0.85);
        k = 1.0 + 0.03 * grain;
    }
    // Wetlands: low, wet ground beside water.
    if g.wet > 0.5 && g.slope < 0.03 && g.rain > 250.0 {
        c = lerp3(c, [88.0, 110.0, 70.0], (g.wet - 0.5) * 0.8);
    }
    // Beaches: a pale strip where gentle land meets the sea.
    if g.shore >= 0.0 && g.slope < 0.12 && g.temp > -2.0 {
        let w = 0.12 + px * 0.9;
        if g.shore < w {
            c = lerp3(c, [214.0, 198.0, 152.0], 0.9 * (1.0 - g.shore / w));
        }
    }
    // Bare rock on steep ground, which vegetation only partly hides.
    let rock_t = smooth(0.30, 0.85, g.slope) * (1.0 - 0.45 * veg);
    let rock = lerp3([122.0, 110.0, 98.0], [176.0, 170.0, 164.0], smooth(0.0, 4000.0, g.elev));
    let rock_k = 0.9 + 0.2 * band(g.x, g.y, 6.0, 0.2, px, 41);
    c = lerp3(c, [rock[0] * rock_k, rock[1] * rock_k, rock[2] * rock_k], rock_t);
    // Snow: below about -2 °C, with a ragged edge, shed from the steepest slopes.
    let snowline = g.temp + 1.6 * band(g.x, g.y, 12.0, 0.5, px, 53);
    let snow = smooth(-2.0, -7.0, snowline) * (1.0 - 0.75 * smooth(0.55, 1.3, g.slope));
    c = lerp3(c, [240.0, 243.0, 247.0], snow);

    let m = shade * g.ao * k;
    grade([c[0] * m, c[1] * m, c[2] * m], style)
}

/// Colour of water, `depth` metres deep. `plume` (0..1) is sediment washed
/// out from a river mouth.
pub fn water(depth: f32, lake: bool, plume: f32, style: Style) -> [f32; 3] {
    if style == Style::Atlas {
        return tint(-depth.max(0.5));
    }
    let c = if lake {
        lerp3([70.0, 138.0, 138.0], [16.0, 62.0, 92.0], smooth(0.0, 45.0, depth))
    } else {
        // Sandy shallows over the shelf, then darkening to the deep.
        let shelf = lerp3([98.0, 176.0, 170.0], [34.0, 118.0, 150.0], smooth(0.0, 40.0, depth));
        lerp3(shelf, [10.0, 40.0, 82.0], smooth(40.0, 1800.0, depth))
    };
    grade(lerp3(c, [128.0, 132.0, 92.0], plume.clamp(0.0, 1.0) * 0.65), style)
}

/// Colour of a river by its flow (m³/s): clear and green when small, deeper
/// and browner with silt when large.
pub fn river(q: f32, style: Style) -> [f32; 3] {
    if style == Style::Atlas {
        return [74.0, 143.0, 174.0];
    }
    grade(lerp3([96.0, 140.0, 142.0], [44.0, 92.0, 126.0], smooth(5.0, 2000.0, q)), style)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ground() -> Ground {
        Ground { x: 100.0, y: 100.0, elev: 300.0, slope: 0.02, temp: 14.0, rain: 900.0, wet: 0.0, shore: -1.0, pan: false, light: 1.0, ao: 1.0, humid: 0.5, forest: 0.0, forest_w: 0.0 }
    }

    fn green_excess(c: [f32; 3]) -> f32 {
        c[1] - 0.5 * (c[0] + c[2])
    }

    #[test]
    fn wet_land_is_greener_than_dry_land() {
        let wet = land(&ground(), 0.2, Style::TrueColour);
        let dry = land(&Ground { rain: 100.0, ..ground() }, 0.2, Style::TrueColour);
        assert!(green_excess(wet) > green_excess(dry) + 8.0, "wet {wet:?} dry {dry:?}");
    }

    #[test]
    fn cold_peaks_are_snowy_and_steep_ground_is_rock() {
        let peak = land(&Ground { temp: -14.0, elev: 4800.0, slope: 0.25, ..ground() }, 0.2, Style::TrueColour);
        assert!(peak.iter().all(|v| *v > 190.0), "snow cap {peak:?}");
        let cliff = land(&Ground { slope: 1.2, ..ground() }, 0.2, Style::TrueColour);
        let grass = land(&ground(), 0.2, Style::TrueColour);
        assert!(green_excess(cliff) < green_excess(grass) - 6.0, "cliff {cliff:?} vs grass {grass:?}");
    }

    #[test]
    fn a_biome_region_sets_tree_cover_and_dry_air_browns_the_land() {
        // Grassland rain, but the region asks for dense forest: much greener and darker.
        let grass = land(&Ground { rain: 450.0, ..ground() }, 6.0, Style::TrueColour);
        let wooded = land(&Ground { rain: 450.0, forest: 0.95, forest_w: 1.0, ..ground() }, 6.0, Style::TrueColour);
        assert!(wooded[0] < grass[0] - 30.0, "wooded {wooded:?} grass {grass:?}");
        // Forest rain, but the region asks for none: open country.
        let forest = land(&ground(), 6.0, Style::TrueColour);
        let cleared = land(&Ground { forest: 0.0, forest_w: 1.0, ..ground() }, 6.0, Style::TrueColour);
        assert!(cleared[0] > forest[0] + 30.0, "cleared {cleared:?} forest {forest:?}");
        let arid = land(&Ground { humid: 0.05, ..ground() }, 6.0, Style::TrueColour);
        assert!(green_excess(arid) < green_excess(forest) - 5.0, "arid {arid:?} forest {forest:?}");
    }

    #[test]
    fn deep_water_is_darker_than_shallows_and_valleys_are_darker_than_ridges() {
        let (shallow, deep) = (water(5.0, false, 0.0, Style::TrueColour), water(3000.0, false, 0.0, Style::TrueColour));
        assert!(shallow[1] > deep[1] + 60.0);
        let open = land(&ground(), 0.2, Style::TrueColour);
        let valley = land(&Ground { ao: 0.6, ..ground() }, 0.2, Style::TrueColour);
        assert!(valley[1] < open[1] * 0.75);
    }

    #[test]
    fn the_same_place_always_gets_the_same_colour() {
        assert_eq!(land(&ground(), 0.3, Style::Vivid), land(&ground(), 0.3, Style::Vivid));
        assert_ne!(land(&ground(), 0.3, Style::Vivid), land(&ground(), 0.3, Style::TrueColour));
    }
}
