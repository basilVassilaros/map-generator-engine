//! Climate, drainage and the terrain render.

use terrain_core::engine::LAND;
use terrain_core::hydro::{climate, render as render_with, route, sea_level_temperature, wind_direction, Climate};
use terrain_core::look::Style;
use terrain_core::{Coastline, Engine, Frame, Mountain, SegmentParams, Shape, ShapeKind};

const SIZE: u32 = 256;
const EXTENT_KM: f32 = 1600.0;

fn render(e: &Engine, c: &Climate) -> terrain_core::hydro::Rendered {
    render_with(e, c, Style::TrueColour)
}

fn continent(height: f32) -> Shape {
    let points: Vec<[f32; 2]> = (0..9)
        .map(|i| {
            let a = i as f32 / 9.0 * std::f32::consts::TAU;
            [800.0 + 620.0 * a.cos(), 800.0 + 520.0 * a.sin()]
        })
        .collect();
    let params = points.iter().map(|_| SegmentParams::default()).collect();
    Shape { id: 1, coast: Coastline { points, params, seed: 5 }, frame: Frame { x: 800.0, y: 800.0, angle: 0.0, scale: 1.0 }, kind: ShapeKind::Land, height }
}

/// A continent with a north-south mountain range down its middle.
fn world() -> Engine {
    let range = Mountain { id: 1, seed: 3, points: vec![[800.0, 380.0], [800.0, 1220.0]], height: 3000.0, width_km: 90.0, rugged: 0.6, ..Default::default() };
    let mut e = Engine::new(SIZE, SIZE, EXTENT_KM);
    e.set_guides(42, vec![continent(300.0)], vec![range], vec![]);
    e
}

#[test]
fn every_cell_drains_downhill_to_water_or_the_edge() {
    let e = world();
    let (w, h) = (SIZE as usize, SIZE as usize);
    let fixed: Vec<bool> = e.water().iter().map(|k| *k != LAND).collect();
    let r = route(e.elevation(), &fixed, w, h);
    for start in (0..w * h).step_by(37) {
        let (mut i, mut steps) = (start, 0);
        while r.receiver[i] as usize != i {
            let to = r.receiver[i] as usize;
            assert!(r.filled[to] <= r.filled[i], "route climbs from {i} to {to}");
            i = to;
            steps += 1;
            assert!(steps < w * h, "route from {start} never ends");
        }
        let (x, y) = (i % w, i / w);
        assert!(fixed[i] || x == 0 || y == 0 || x == w - 1 || y == h - 1, "route from {start} ends on dry land");
    }
}

#[test]
fn temperature_falls_towards_the_poles_and_with_height() {
    assert!(sea_level_temperature(0.0) > 24.0);
    assert!(sea_level_temperature(45.0) < sea_level_temperature(20.0));
    assert!(sea_level_temperature(80.0) < -5.0);
    let e = world();
    let (w, h) = (SIZE as usize, SIZE as usize);
    let wet: Vec<bool> = e.water().iter().map(|k| *k != LAND).collect();
    let (t, _) = climate(e.elevation(), &wet, w, h, e.cell_km(), 0.0, EXTENT_KM, &Climate::default());
    let at = |x: f32, y: f32| t[(y / e.cell_km()) as usize * w + (x / e.cell_km()) as usize];
    assert!(at(800.0, 800.0) < at(500.0, 800.0) - 8.0, "the mountain crest is much colder than the plain");
}

/// Mean rainfall on the land west and east of the range.
fn rain_either_side(latitude: f32) -> (f32, f32) {
    let e = world();
    let (w, h) = (SIZE as usize, SIZE as usize);
    let wet: Vec<bool> = e.water().iter().map(|k| *k != LAND).collect();
    let (_, rain) = climate(e.elevation(), &wet, w, h, e.cell_km(), 0.0, EXTENT_KM, &Climate { latitude, ..Climate::default() });
    let mean = |x0: f32, x1: f32| {
        let (mut sum, mut n) = (0.0, 0);
        for y in (600.0 / e.cell_km()) as usize..(1000.0 / e.cell_km()) as usize {
            for x in (x0 / e.cell_km()) as usize..(x1 / e.cell_km()) as usize {
                sum += rain[y * w + x];
                n += 1;
            }
        }
        sum / n as f32
    };
    (mean(450.0, 700.0), mean(900.0, 1150.0))
}

#[test]
fn mountains_cast_a_rain_shadow_downwind() {
    // Mid-latitudes: westerlies. Wet in the west, dry in the east.
    assert_eq!(wind_direction(45.0), 1);
    let (west, east) = rain_either_side(45.0);
    assert!(west > east * 1.8, "westerlies: west {west} mm, east {east} mm");
    // Tropics: easterly trade winds. The shadow falls on the other side.
    assert_eq!(wind_direction(12.0), -1);
    let (west, east) = rain_either_side(12.0);
    assert!(east > west * 1.8, "trade winds: west {west} mm, east {east} mm");
}

#[test]
fn rainfall_averages_what_was_asked_for() {
    let e = world();
    let (w, h) = (SIZE as usize, SIZE as usize);
    let wet: Vec<bool> = e.water().iter().map(|k| *k != LAND).collect();
    let (_, rain) = climate(e.elevation(), &wet, w, h, e.cell_km(), 0.0, EXTENT_KM, &Climate { rainfall_mm: 650.0, ..Climate::default() });
    let land: Vec<f32> = (0..w * h).filter(|i| !wet[*i]).map(|i| rain[i]).collect();
    let mean = land.iter().sum::<f32>() / land.len() as f32;
    assert!((mean - 650.0).abs() < 5.0, "mean {mean} mm");
}

#[test]
fn render_cuts_valleys_and_grows_rivers_that_gain_water_downstream() {
    let e = world();
    let out = render(&e, &Climate { evaporation_mm: 0.0, ..Climate::default() });
    assert!(out.river_cells > 200, "{} river cells", out.river_cells);
    let (w, h) = (SIZE as usize, SIZE as usize);
    let fixed: Vec<bool> = e.water().iter().map(|k| *k != LAND).collect();
    let (mut lower, mut higher) = (0, 0);
    for i in 0..w * h {
        if !fixed[i] {
            if out.elevation[i] < e.elevation()[i] - 1.0 { lower += 1; }
            // Shallow hollows silt up (under 40 m) and hills stand on the
            // divides (under 450 m); nothing else rises.
            if out.elevation[i] > e.elevation()[i] + 42.0 + 450.0 { higher += 1; }
        }
    }
    assert!(lower > 2000, "erosion lowered only {lower} cells");
    assert_eq!(higher, 0, "nothing raises the ground beyond hills and silted hollows");
    // With no evaporation, a river never loses water on its way down.
    let r = route(&out.elevation, &fixed, w, h);
    for i in 0..w * h {
        let to = r.receiver[i] as usize;
        if to != i && !fixed[to] {
            assert!(out.discharge[to] >= out.discharge[i] - 1e-3, "river loses water between {i} and {to}");
        }
    }
}

#[test]
fn render_is_repeatable() {
    let a = render(&world(), &Climate::default());
    let b = render(&world(), &Climate::default());
    assert_eq!(a.rgba, b.rgba);
}

#[test]
fn dry_climates_leave_lakes_without_outflow() {
    // A basin ringed by high ground, in a dry climate: its lake swallows the
    // rivers running into it.
    let rim = Mountain { id: 1, seed: 3, points: vec![[560.0, 560.0], [1040.0, 560.0], [1040.0, 1040.0], [560.0, 1040.0], [560.0, 560.0]], height: 2500.0, width_km: 70.0, rugged: 0.3, ..Default::default() };
    let mut e = Engine::new(SIZE, SIZE, EXTENT_KM);
    e.set_guides(42, vec![continent(400.0)], vec![rim], vec![]);
    let wet = render(&e, &Climate { rainfall_mm: 1200.0, evaporation_mm: 0.0, erosion_rounds: 0, ..Climate::default() });
    let dry = render(&e, &Climate { rainfall_mm: 150.0, evaporation_mm: 2500.0, erosion_rounds: 0, ..Climate::default() });
    assert!(wet.lake_cells > 50, "the basin holds a lake ({} cells)", wet.lake_cells);
    assert!(dry.river_cells < wet.river_cells / 4, "dry: {} river cells, wet: {}", dry.river_cells, wet.river_cells);
}
