// Biome presets for the biome brush. Each sets the climate inside a painted
// region: rainfall, how humid the air is, how much of the ground is wooded,
// and (optionally) the mean temperature at sea level. Every value can be
// changed per region afterwards; the preset is just the starting point.
//
// Figures are typical of each biome on Earth (Whittaker's biome diagram and
// standard climatologies), rounded.

export interface BiomePreset {
  key: string;
  name: string;
  rainfall: number; // mm a year
  humidity: number; // 0..1
  forest: number; // 0..1
  /** Mean temperature at sea level (°C), or null to follow the map's latitude. */
  temp: number | null;
  /** Fill colour for the region on the map. */
  colour: string;
  note: string;
}

export const BIOMES: readonly BiomePreset[] = [
  { key: "rainforest", name: "Tropical rainforest", rainfall: 2600, humidity: 0.92, forest: 0.95, temp: 26, colour: "#2f8a3e", note: "Hot, wet all year, closed canopy." },
  { key: "monsoon", name: "Tropical seasonal forest", rainfall: 1600, humidity: 0.7, forest: 0.7, temp: 25, colour: "#5a9a3a", note: "A wet season and a dry one; patchier canopy." },
  { key: "savanna", name: "Savanna", rainfall: 900, humidity: 0.45, forest: 0.15, temp: 25, colour: "#b4a64c", note: "Grassland with scattered trees." },
  { key: "hot-desert", name: "Hot desert", rainfall: 80, humidity: 0.08, forest: 0, temp: 27, colour: "#d9b26f", note: "Sand, gravel and salt pans." },
  { key: "cold-desert", name: "Cold desert", rainfall: 180, humidity: 0.2, forest: 0, temp: 5, colour: "#bdb39a", note: "Dry steppe and stony plateaus with cold winters." },
  { key: "mediterranean", name: "Mediterranean scrub", rainfall: 550, humidity: 0.35, forest: 0.3, temp: 16, colour: "#9c9c52", note: "Dry summers; scrub, olive and oak woodland." },
  { key: "grassland", name: "Temperate grassland", rainfall: 500, humidity: 0.45, forest: 0.05, temp: 10, colour: "#a9b25e", note: "Prairie and steppe." },
  { key: "deciduous", name: "Temperate forest", rainfall: 1000, humidity: 0.62, forest: 0.8, temp: 11, colour: "#4f8a45", note: "Broadleaf woods with clearings." },
  { key: "temperate-rainforest", name: "Temperate rainforest", rainfall: 2400, humidity: 0.88, forest: 0.95, temp: 10, colour: "#2e6f47", note: "Cool, very wet coasts; dense conifers." },
  { key: "boreal", name: "Boreal forest (taiga)", rainfall: 500, humidity: 0.6, forest: 0.75, temp: -2, colour: "#3e6650", note: "Cold conifer forest with bogs." },
  { key: "tundra", name: "Tundra", rainfall: 250, humidity: 0.5, forest: 0, temp: -10, colour: "#9aa592", note: "Treeless, frozen much of the year." },
  { key: "wetland", name: "Wetland", rainfall: 1400, humidity: 0.95, forest: 0.3, temp: null, colour: "#5f7f55", note: "Marsh and swamp; keeps the latitude's temperature." },
];

export const DEFAULT_BIOME = "deciduous";

export function biome(key: string): BiomePreset {
  return BIOMES.find((b) => b.key === key) ?? BIOMES.find((b) => b.key === DEFAULT_BIOME)!;
}
