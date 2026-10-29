//! terrain-core: turns the user's guides into terrain.
//!
//! Compiled natively for tests and benchmarks, and to WebAssembly for the
//! browser, where `ffi` exposes a small, flat interface to the web app.

pub mod coast;
pub mod engine;
pub mod noise;
pub mod render;

#[cfg(target_arch = "wasm32")]
mod ffi;

pub use coast::{Coastline, SegmentParams};
pub use engine::{Engine, Rect};
