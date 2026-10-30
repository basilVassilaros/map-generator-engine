# World Map Generator

## Note
This project is mostly made using Claude.ai and thus I am having it be completely open-sourced.
It is to serve more of a concept of what is possible.

## Introduction
For too long the tools available for making realistic maps has been an effort 
in terms of drawing out heightmaps using randomized cells. And if the shape of 
landmass or mountains set is not to your liking, it required you to erase and redraw.

## What is this tool?

A browser tool for generating realistic world maps from rough guides. You draw
a coastline point by point, generate the landmass, then tune each stretch of
coast with sliders and watch the terrain update live.

This is Sprint 1: the coastline pen, live landmass, zoom, and PNG export.
Mountains, rivers, biomes, population, full generation and engine exports
come in later sprints.

## Run it

Open `dist/index.html` in a current version of Chrome, Edge, Firefox or Safari.
It's a single self-contained file, so it works straight from disk with no server.

## Use it

1. Click on the map to place coastline points.
2. Click the first point to close the shape.
3. Choose **Generate landmass**.
4. Click a segment of the coastline to select it, then adjust its sliders.
   Drag points to reshape the coast, double-click a segment to add a point,
   and press Delete to remove a selected point.

5. Scroll or pinch to zoom, or use the zoom controls on the map. Drag empty
   map to pan (or hold Space and drag, which also works while drawing).
   After a moment, the zoomed view sharpens: it is regenerated at full
   detail, not just enlarged.
6. Choose **Export PNG** to download the whole map as an image at the
   working resolution.

The panel at the bottom right shows how long each update took against the
100 ms target.

## Build it

You need Rust with the WebAssembly target, and Node.js 18 or later.

```
rustup target add wasm32-unknown-unknown
cd web
npm install
npm run build      # compiles the core and writes dist/index.html
```

Other commands, all from `web/`:

| Command | What it does |
| --- | --- |
| `npm run check` | Type-checks the interface |
| `npm run bench -- 1024` | Times the core at a given resolution, outside the browser |
| `cargo test --release` (from `core/`) | Runs the core's tests |

## Project layout

```
core/                Rust generation core (compiled to WebAssembly)
  src/coast.rs       Coastline guide, per-segment parameters, terrain profile
  src/engine.rs      World rasters, caches, and exact partial updates
  src/noise.rs       Deterministic noise
  src/render.rs      On-screen preview colours and hillshade
  src/ffi.rs         The narrow boundary the browser calls
  tests/             Determinism and partial-update tests
web/                 TypeScript interface
  src/editor.ts      Coastline pen and guide overlay
  src/main.ts        Panels and wiring
  src/engine-client.ts   Sends edits to the core, latest edit wins
  src/export.ts      PNG export
  src/core-host.ts   Runs the WebAssembly core
  src/worker.ts      Background thread
  scripts/           Build and benchmark
docs/                Architecture and sprint notes
dist/                Build output
```

See `docs/ARCHITECTURE.md` for how the pieces fit together.

## License

Licensed under 

- MIT license ([LICENSE-MIT](LICENSE-MIT))

### Maps you make are yours

These licenses cover the generator's source code, not the maps it produces.
Maps, heightmaps and images you create with the World Map Generator belong to
you. Use them however you like, including in commercial games and products,
with no attribution required.

### Contributing

Unless you explicitly state otherwise, any contribution you intentionally
submit for inclusion in this project, as defined in the Apache-2.0 license,
shall be dual licensed as above, without any additional terms or conditions.
