//! Preview rendering: colour by elevation, then hillshade so relief is readable.
//! This is the on-screen preview only. Exports will read the elevation data
//! directly and never go through these colours.

use crate::engine::Rect;

/// (elevation in metres, colour). Must be sorted by elevation.
const RAMP: &[(f32, [f32; 3])] = &[
    (-4000.0, [22.0, 50.0, 74.0]),
    (-1500.0, [31.0, 72.0, 103.0]),
    (-200.0, [47.0, 106.0, 138.0]),
    (-40.0, [74.0, 143.0, 174.0]),
    (-3.0, [127.0, 183.0, 201.0]),
    (0.0, [216.0, 201.0, 154.0]),
    (6.0, [216.0, 201.0, 154.0]),
    (25.0, [143.0, 168.0, 106.0]),
    (200.0, [111.0, 148.0, 85.0]),
    (500.0, [163.0, 160.0, 100.0]),
    (900.0, [154.0, 125.0, 85.0]),
    (1500.0, [122.0, 100.0, 80.0]),
    (2500.0, [217.0, 212.0, 204.0]),
];

fn tint(elevation: f32) -> [f32; 3] {
    if elevation <= RAMP[0].0 {
        return RAMP[0].1;
    }
    for pair in RAMP.windows(2) {
        let (e0, c0) = pair[0];
        let (e1, c1) = pair[1];
        if elevation <= e1 {
            let t = (elevation - e0) / (e1 - e0);
            return [
                c0[0] + (c1[0] - c0[0]) * t,
                c0[1] + (c1[1] - c0[1]) * t,
                c0[2] + (c1[2] - c0[2]) * t,
            ];
        }
    }
    RAMP[RAMP.len() - 1].1
}

/// Colour and shade the pixels in `r`. `shore` is each cell's signed
/// distance (km) to the coastline, positive on land. With `blend_km` above
/// zero, land and water colours are blended across that width around the
/// coastline, which smooths the stair-stepped edge without supersampling.
#[allow(clippy::too_many_arguments)]
pub fn shade(elevation: &[f32], shore: &[f32], rgba: &mut [u8], width: u32, height: u32, cell_km: f32, blend_km: f32, r: Rect) {
    let cell_m = cell_km * 1000.0;
    // What each side of the coastline looks like right at the edge.
    let beach = tint(1.0);
    let shallows = tint(-15.0);
    const EXAGGERATION: f32 = 4.0;
    // Light from the north-west, 45 degrees up (y grows southwards).
    let light = {
        let (x, y, z) = (-1.0f32, -1.0f32, 1.414f32);
        let len = (x * x + y * y + z * z).sqrt();
        [x / len, y / len, z / len]
    };
    let at = |x: i64, y: i64| -> f32 {
        let x = x.clamp(0, width as i64 - 1) as usize;
        let y = y.clamp(0, height as i64 - 1) as usize;
        elevation[y * width as usize + x]
    };

    for cy in r.y0..r.y1 {
        for cx in r.x0..r.x1 {
            let (x, y) = (cx as i64, cy as i64);
            let e = at(x, y);
            let underwater = e < 0.0;
            // Sea surface is flat: shade the seabed only faintly.
            let (sx, sy) = if underwater {
                (0.0, 0.0)
            } else {
                (
                    (at(x + 1, y).max(0.0) - at(x - 1, y).max(0.0)) / (2.0 * cell_m) * EXAGGERATION,
                    (at(x, y + 1).max(0.0) - at(x, y - 1).max(0.0)) / (2.0 * cell_m) * EXAGGERATION,
                )
            };
            let len = (sx * sx + sy * sy + 1.0).sqrt();
            let lit = (-sx * light[0] - sy * light[1] + light[2]) / len;
            let relative = (lit / light[2]).clamp(0.0, 1.6);
            let strength = if underwater { 0.0 } else { 0.65 };
            let factor = 1.0 + (relative - 1.0) * strength;

            let mut c = tint(e);
            if blend_km > 0.0 {
                // How much of this pixel lies on land, from its distance to the coast.
                let d = shore[cy as usize * width as usize + cx as usize];
                let land = (0.5 + d / blend_km).clamp(0.0, 1.0);
                let (other, amount) = if underwater { (beach, land) } else { (shallows, 1.0 - land) };
                if amount > 0.0 {
                    for k in 0..3 {
                        c[k] += (other[k] - c[k]) * amount;
                    }
                }
            }
            let i = (cy as usize * width as usize + cx as usize) * 4;
            rgba[i] = (c[0] * factor).clamp(0.0, 255.0) as u8;
            rgba[i + 1] = (c[1] * factor).clamp(0.0, 255.0) as u8;
            rgba[i + 2] = (c[2] * factor).clamp(0.0, 255.0) as u8;
            rgba[i + 3] = 255;
        }
    }
}
