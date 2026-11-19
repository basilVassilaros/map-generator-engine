//! terrain-core: turns the user's guides into terrain.
//!
//! Compiled natively for tests and benchmarks, and to WebAssembly for the
//! browser, where `ffi` exposes a small, flat interface to the web app.

pub mod coast;
pub mod engine;
pub mod features;
pub mod fine;
pub mod hydro;
pub mod look;
pub mod noise;
pub mod plan;
pub mod render;

#[cfg(target_arch = "wasm32")]
mod ffi;

pub use coast::{Coastline, Frame, SegmentParams, Shape, ShapeKind, AUTO_LEVEL};
pub use features::{Mountain, River};
pub use engine::{Engine, Rect};
