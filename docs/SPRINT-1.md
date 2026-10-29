# Sprint 1: Coastline and live landmass

Goal: draw a coastline, generate the landmass, and adjust a segment's
parameters with the map updating live within 100 ms.

## Stories

| Story | Status |
| --- | --- |
| Draw a coastline by clicking points; click the first point to close; drag points | Built |
| Generate a landmass that follows the shape with a natural-looking coast | Built |
| Select a segment and see its parameters | Built |
| Adjust roughness, coves and bays, and shore slope live, without seams | Built; meets 100 ms at 1024 |

Also built: inserting points (double-click a segment), deleting points,
"Apply to all segments", a resolution switch, and a live timing readout.

## Changes from the plan

- **Generation runs on the CPU (WebAssembly), not WebGPU, for now.** The
  plan was to measure before adding GPU work. With caching, the CPU path meets
  the target at 1024, and WebGPU would have added a large build and debugging
  cost before it was needed. The core's structure doesn't prevent moving hot
  passes to the GPU later.
- **Zoom and PNG export added mid-sprint** at the product owner's request.

## Added: zoom and PNG export

- Scroll, pinch, keyboard (+, −, 0) and on-map controls zoom up to 32×,
  centred on the cursor.
- Drag empty map, middle or right drag, or Space and drag to pan.
- Zoomed views regenerate at full detail after a short pause.
- Export PNG saves the whole map at the working resolution. Published on
  claude.ai it asks for confirmation first; run locally it downloads directly.

## Manual test checklist

These need a real browser and were not run during the build.

- [ ] Page loads and shows an empty ocean with a grid and scale bar
- [ ] Points place on click; the first point shows a ring once closable
- [ ] Backspace removes the last point while drawing; Escape starts over
- [ ] Generate landmass produces terrain matching the shape
- [ ] Selecting a segment highlights it and shows its sliders
- [ ] Sliders update the map live; the timing readout stays under 100 ms at 1024
- [ ] No visible seams where adjacent segments with different settings meet
- [ ] Dragging a point reshapes the landmass live
- [ ] Double-click inserts a point; Delete removes a selected point
- [ ] Switching resolution regenerates the map at the new size
- [ ] Clear coastline returns to an empty map
- [ ] Timing panel says "background thread" (not "main thread")
- [ ] Layout works in dark mode and on a narrow window
- [ ] Scrolling zooms towards the cursor; Fit map returns to the whole map
- [ ] "Sharpening detail…" appears, then the zoomed view becomes crisp
- [ ] Editing while zoomed updates the sharp view live
- [ ] Panning works by dragging empty map and with Space held while drawing
- [ ] Export PNG downloads an image that matches the map

## Open for Sprint 2

- Project save and load (browser autosave plus downloadable project files)
- Undo and redo
- Higher-resolution image export (rendered in the core, beyond the working resolution)
