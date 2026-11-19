//! Stage B: fine detail rendered in strips.

use terrain_core::fine::{render_fine, Structure};
use terrain_core::hydro::{render, Climate};
use terrain_core::look::Style;
use terrain_core::{Coastline, Engine, Frame, Mountain, River, SegmentParams, Shape, ShapeKind};

fn continent() -> Shape {
    let points: Vec<[f32; 2]> = (0..9)
        .map(|i| {
            let a = i as f32 / 9.0 * std::f32::consts::TAU;
            [800.0 + 620.0 * a.cos(), 800.0 + 520.0 * a.sin()]
        })
        .collect();
    let params = points.iter().map(|_| SegmentParams::default()).collect();
    Shape { id: 1, coast: Coastline { points, params, seed: 5 }, frame: Frame { x: 800.0, y: 800.0, angle: 0.0, scale: 1.0 }, kind: ShapeKind::Land, height: 300.0 }
}

fn guides() -> (Vec<Shape>, Vec<Mountain>, Vec<River>) {
    let range = Mountain { id: 1, seed: 3, points: vec![[800.0, 380.0], [800.0, 1220.0]], height: 3000.0, width_km: 90.0, rugged: 0.6, curviness: 0.5, ..Default::default() };
    let river = River { id: 1, points: vec![[1000.0, 500.0], [1200.0, 700.0], [1350.0, 800.0]], width_km: 3.0, depth_m: 25.0, curviness: 0.5, ..Default::default() };
    (vec![continent()], vec![range], vec![river])
}

fn structure(size: u32) -> Structure {
    let (shapes, mountains, rivers) = guides();
    let mut e = Engine::new(size, size, 1600.0);
    e.set_guides(42, shapes, mountains, rivers);
    render(&e, &Climate::default(), Style::TrueColour).structure
}

/// An engine window `rows + 2 * halo` tall whose middle starts at (x, y) km.
fn window(x: f32, y: f32, cell: f32, width: u32, rows: u32, halo: u32) -> Engine {
    let (shapes, mountains, rivers) = guides();
    let mut e = Engine::window(width, rows + 2 * halo, [x, y - halo as f32 * cell], cell);
    e.set_guides(42, shapes, mountains, rivers);
    e
}

#[test]
fn strips_render_identically_to_the_whole_window() {
    let s = structure(160);
    let (x, y, cell, width, halo) = (500.0, 600.0, 1.5, 200u32, 3u32);
    let whole = render_fine(&window(x, y, cell, width, 90, halo), &s, Style::TrueColour, 90, halo as usize);
    let top = render_fine(&window(x, y, cell, width, 45, halo), &s, Style::TrueColour, 45, halo as usize);
    let bottom = render_fine(&window(x, y + 45.0 * cell, cell, width, 45, halo), &s, Style::TrueColour, 45, halo as usize);
    let joined: Vec<u8> = top.into_iter().chain(bottom).collect();
    assert_eq!(whole.len(), joined.len());
    let differing = whole.iter().zip(&joined).filter(|(a, b)| a != b).count();
    assert_eq!(differing, 0, "{differing} of {} bytes differ across the strip seam", whole.len());
}

#[test]
fn a_structure_survives_being_sent_to_a_worker() {
    let s = structure(128);
    let copy = Structure::from_f32(&s.to_f32()).expect("loads");
    assert_eq!((copy.w, copy.h, copy.curves.len()), (s.w, s.h, s.curves.len()));
    let a = render_fine(&window(600.0, 700.0, 2.0, 120, 60, 3), &s, Style::Vivid, 60, 3);
    let b = render_fine(&window(600.0, 700.0, 2.0, 120, 60, 3), &copy, Style::Vivid, 60, 3);
    assert_eq!(a, b);
    assert!(Structure::from_f32(&[1.0, 2.0, 3.0]).is_none(), "garbage is refused, not trusted");
}

#[test]
fn the_structure_has_a_drainage_network_and_the_render_uses_it() {
    let s = structure(160);
    assert!(s.curves.len() > 100, "{} river curves", s.curves.len());
    // Rivers are drawn: some pixels in a window over the interior are river-coloured.
    let pixels = render_fine(&window(1000.0, 500.0, 1.0, 300, 300, 3), &s, Style::TrueColour, 300, 3);
    let near_river = pixels.chunks_exact(4).filter(|p| p[2] as i32 > p[0] as i32 + 25 && p[2] as i32 > p[1] as i32 - 10).count();
    assert!(near_river > 200, "only {near_river} river pixels");
}

#[test]
fn styles_differ_and_rendering_is_repeatable() {
    let s = structure(128);
    let (w1, w2) = (window(600.0, 700.0, 2.0, 100, 50, 3), window(600.0, 700.0, 2.0, 100, 50, 3));
    let a = render_fine(&w1, &s, Style::TrueColour, 50, 3);
    assert_eq!(a, render_fine(&w2, &s, Style::TrueColour, 50, 3));
    assert_ne!(a, render_fine(&w1, &s, Style::Atlas, 50, 3));
}
