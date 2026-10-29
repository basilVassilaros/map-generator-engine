//! Deterministic 2D gradient noise.
//!
//! Inputs are world positions (kilometres) divided by a wavelength, so the same
//! place on the map always gets the same value, whatever the working resolution.
//! No global state and no platform randomness: identical inputs give identical
//! output on every machine, which the save format relies on.

#[inline]
fn hash(ix: i32, iy: i32, seed: u32) -> u32 {
    let mut h = seed ^ 0x9e37_79b9;
    h ^= (ix as u32).wrapping_mul(0x85eb_ca6b);
    h = h.rotate_left(13).wrapping_mul(0xc2b2_ae35);
    h ^= (iy as u32).wrapping_mul(0x27d4_eb2f);
    h = h.rotate_left(17).wrapping_mul(0x1656_67b1);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2c1b_3c6d);
    h ^= h >> 12;
    h
}

const D: f32 = std::f32::consts::FRAC_1_SQRT_2;
const GRADIENTS: [(f32, f32); 8] = [
    (1.0, 0.0),
    (-1.0, 0.0),
    (0.0, 1.0),
    (0.0, -1.0),
    (D, D),
    (-D, D),
    (D, -D),
    (-D, -D),
];

#[inline]
fn fade(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

/// Single octave of gradient noise, roughly in [-1, 1].
pub fn gradient(x: f32, y: f32, seed: u32) -> f32 {
    let x0 = x.floor();
    let y0 = y.floor();
    let ix = x0 as i32;
    let iy = y0 as i32;
    let fx = x - x0;
    let fy = y - y0;

    let corner = |cx: i32, cy: i32, dx: f32, dy: f32| {
        let g = GRADIENTS[(hash(cx, cy, seed) & 7) as usize];
        g.0 * dx + g.1 * dy
    };

    let n00 = corner(ix, iy, fx, fy);
    let n10 = corner(ix + 1, iy, fx - 1.0, fy);
    let n01 = corner(ix, iy + 1, fx, fy - 1.0);
    let n11 = corner(ix + 1, iy + 1, fx - 1.0, fy - 1.0);

    let u = fade(fx);
    let v = fade(fy);
    let a = n00 + u * (n10 - n00);
    let b = n01 + u * (n11 - n01);
    (a + v * (b - a)) * std::f32::consts::SQRT_2
}

/// Fractal sum of octaves, normalised to roughly [-1, 1].
pub fn fbm(x: f32, y: f32, seed: u32, octaves: u32, gain: f32) -> f32 {
    let mut sum = 0.0;
    let mut amplitude = 1.0;
    let mut norm = 0.0;
    let mut frequency = 1.0;
    for octave in 0..octaves {
        let octave_seed = seed.wrapping_add(octave.wrapping_mul(0x51ed_270b));
        sum += amplitude * gradient(x * frequency, y * frequency, octave_seed);
        norm += amplitude;
        amplitude *= gain;
        frequency *= 2.0;
    }
    sum / norm
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noise_stays_in_range() {
        let mut lo = f32::MAX;
        let mut hi = f32::MIN;
        for i in 0..20_000 {
            let x = (i as f32) * 0.173;
            let y = (i as f32) * 0.311;
            let v = gradient(x, y, 7);
            lo = lo.min(v);
            hi = hi.max(v);
        }
        assert!(lo >= -1.05 && hi <= 1.05, "range {lo}..{hi}");
    }

    #[test]
    fn noise_is_deterministic() {
        assert_eq!(fbm(12.3, 45.6, 99, 4, 0.5), fbm(12.3, 45.6, 99, 4, 0.5));
        assert_ne!(fbm(12.3, 45.6, 99, 4, 0.5), fbm(12.3, 45.6, 100, 4, 0.5));
    }
}
