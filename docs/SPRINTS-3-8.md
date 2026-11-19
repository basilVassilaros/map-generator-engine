# Sprints 3 to 8, and the rounds after: status

## Built

| Sprint | Item | Notes |
| --- | --- | --- |
| 3 | Height on every land and water shape | Absolute heights; the Highland kind is gone |
| 3 | Land on land makes an escarpment | Automatic; one Slope slider for coasts and escarpments, per segment |
| 3 | Stacking order | Move up / Move down in the shape panel |
| 3 | Flooding | Follows the ground: low land floods from water it touches; cut-off basins stay dry |
| 3 | Project files | Export dialog saves; Import opens; versioned; reference image included |
| 3 | Autosave | In the browser, restored on reload (without the reference image) |
| 4 | Mountains | A point is a peak, a line a range; height, width, ruggedness; islands in the sea |
| 4 | Generate stays available | Becomes "New variation": new seeds for everything unlocked |
| 5 | Rivers | A point is a pool, a line a river; width and channel depth; always downhill |
| 6 | Render terrain | Notice with requirements and "don't show again"; drainage and valley cutting |
| 7 | Pools | Hollows fill to their spill level as lakes |
| 8 | Rivers from enough water | Discharge from rain over each catchment, less evaporation |
| + | Climate and biomes | Latitude temperature, prevailing winds, rain shadows, Whittaker colours |
| + | Live speed | Half-resolution preview engine alongside the full one |

## Next round (curves and satellite-style terrain)

| Item | Status |
| --- | --- |
| Curved rivers and ranges (curviness, draggable bends) | Built |
| Satellite look: texture, rock, snow, water, light; three styles | Built |
| Coarse-to-fine terrain render in strips on workers | Built; whole map at 2048 or 4096 px |
| Sections: render just the current view at fine detail | Built (as "This view only") |
| Terrain render works zoomed in | Built, via the detail render |
| GPU acceleration | Not built: the CPU path was fast enough; kept as an option |

Also fixed along the way: overlapping land shapes with different slopes made a
cliff where one shape's coast takes over from the other's; the coast ramp was
applied twice; mountain islands were drawn as all beach.

## Final round (rivers, biomes, planned features, exports)

| Item | Status |
| --- | --- |
| Drawn rivers render as realistic rivers | Built: meanders about a dozen channel widths long, fading out at source and mouth; the channel always descends and gathers the drainage around it; tributaries end on it |
| Terrain export as crisp as the fully zoomed canvas | Built: whole map or current view, up to 16384 px, rendered in strips straight into the PNG |
| Heightmap export | Built: 16-bit greyscale PNG of the ground (under water too), at Unreal landscape sizes, with the Z and X/Y scale to use |
| Generated rivers, hills and lakes as vectors that drive the terrain | Built: rivers traced down the drainage, hills along the divides between rivers (skipping drawn ranges), lake outlines; shown over the map and can be kept as guides |
| Biome brush with presets | Built: twelve presets; rainfall, humidity, forest cover, temperature (or the latitude's) and soft edge per region; Regenerate terrain |
| Mountain texture follows drainage | Built: slopes are cut into V-shaped gullies along every stream and rise to rounded crests between them, deeper for bigger streams; steep ground is roughened before erosion so streams branch instead of running in parallel |
| Zoomed-in terrain | Built: the view is re-rendered in fine detail at screen resolution |

## Decisions taken, open to change

- **Heights are absolute**, not relative to the land below.
- **A lake that follows the ground sits in a hollow** just below the lowest
  nearby ground, so it never spills over its surroundings.
- **The terrain render runs on the CPU, not the GPU.** It takes about 2.5 s
  at 1024, and the same project renders identically on every machine.
  GPU acceleration can come later for higher resolutions.
- **Rainfall is one average for the map**, redistributed by wind and
  mountains, except inside biome regions, which set their own. Evaporation is
  one figure.
- **Biome regions change only the terrain render**, not the live map, so
  painting them stays instant.
- **Planned hills are part of every render**; keeping them as guides is
  optional. Kept lakes follow the ground, because the render's spill level
  stands on its own hills and valleys and would flood the live map.

## Known limits

- **Terrain exports need a terrain render first**, and are made from it: edit
  the map and render again to export the change.
- **Terrain exports stop at 16384 px** on a side; for finer detail export the
  current view.
- **Heightmap black and white are set from the render's lowest and highest
  ground** (with a margin), shown in the file name and before exporting.
- **Rivers are drawn in colour, not cut into fine heightmaps** below the
  working grid's resolution.
- **Zoomed views and full-detail exports work out flooding within their own
  area**, so a low region connected to the sea only outside that area can
  appear dry there.
- **Mountains and rivers have settings per feature**, not per point or segment.
- **Rivers on very flat ground can run in straight lines** for a stretch.
- **Winds blow due east or west** by latitude band; there are no north-south
  components, monsoons or ocean currents.
- **Only the map centre's latitude is set.** The full latitude/longitude
  window and globe view are still to come.
- **No undo yet.**

## Not built

- Rain shapes and wind shapes drawn by the user (biome regions cover rain per area)
- Population tool; settlements
- Globe view and map projections
- Data-layer exports (biome, rainfall, water masks) for game engines
- Merge rules (minimum water gap between landmasses)

## Tests

62 core tests (every edit matches a full regeneration exactly; heights,
escarpments, flooding, mountains, rivers running downhill; rain shadows flip
with wind direction; rivers gain water downstream; dry-climate lakes have no
outflow; drawn rivers become descending channels that gather water; biome
regions set the climate inside them and nowhere else; planned rivers run
downhill and planned hills stand on the divides; basins fill into lakes with
outlines; fine heights match whether rendered whole or in strips; renders are
repeatable) and a 94-check browser test in headless Firefox.
