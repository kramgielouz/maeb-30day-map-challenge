import { lazy } from 'react';
import type maplibregl from 'maplibre-gl';

export type DayComponent = React.ComponentType<{ map: maplibregl.Map }>;

export interface DayMeta {
  day: number;
  slug: string;
  theme: string;
  prompt: string; // official one-line prompt
  title: string; // your chapter title
  insight: string; // one-sentence takeaway shown in the side panel
  sources: string[];
  needsHuman?: boolean; // days that cannot be finished with online data alone
}

export interface DayEntry extends DayMeta {
  Component: React.LazyExoticComponent<DayComponent> | null; // null = not built yet
}

// Planned chapters. Edit title/insight/sources here as each day gets built.
const META: DayMeta[] = [
  { day: 1, slug: 'points', theme: 'Points', prompt: 'A map challenge classic. Map with points.', title: 'Critical facilities', insight: 'Where the city keeps its safety net: hospitals, schools, fire stations and evacuation-capable sites.', sources: ['OpenStreetMap contributors (ODbL): city boundary via Nominatim, facilities via Overpass'] },
  { day: 2, slug: 'lines', theme: 'Lines', prompt: 'A map challenge classic. Map with lines.', title: 'Waterways of Butuan', insight: 'Every mapped river, canal, stream and drain inside the city, with dashes crawling downstream. Compare how much of the network is named.', sources: ['OpenStreetMap contributors (ODbL), via Overpass'] },
  { day: 3, slug: 'polygons', theme: 'Polygons', prompt: 'A map challenge classic. Map with polygons.', title: 'Low, wet and far from help', insight: 'The city cut into equal hexagons, each scored on how much of it is low-lying and close to water, and how far it is from a hospital. The darkest cells are exposed and far from help.', sources: ['OpenStreetMap contributors (ODbL): city boundary, hospitals (Day 1) and waterways (Day 2)', 'AWS Open Data Terrain Tiles (Terrarium) for elevation'] },
  { day: 4, slug: 'clusters', theme: 'Clusters', prompt: 'Clusters of something. Hotspots, groups, things that gather together.', title: 'Where things gather', insight: 'Shops, services and amenities cluster hard around the centre. Switch between clusters and heat, and see how few grid cells hold most places.', sources: ['OpenStreetMap contributors (ODbL), via Overpass'] },
  { day: 5, slug: 'sight', theme: 'Senses: Sight', prompt: 'How do you see something? Maybe map a viewshed?', title: 'What can you see from here?', insight: 'A live viewshed computed in your browser. On terrain alone the Agusan plain looks open for kilometres; add buildings and trees and the view collapses to a few streets. Move the pin, read the skyline, or scan the window for the best views.', sources: ['AWS Open Data Terrain Tiles (Terrarium encoding), see registry.opendata.aws/terrain-tiles for attribution', 'OpenStreetMap contributors (ODbL): boundary, building and woodland footprints'] },
  { day: 6, slug: 'vintage', theme: 'Vintage', prompt: 'Spin up your time machine and do a map which looks like a historical map.', title: 'Port of the balanghai', insight: "The city redrawn as an old sea chart: ink, parchment and rhumb lines fanning out from the Agusan river port toward its trading partners. Sail out to see them, or stay to find the heritage sites.", sources: ['OpenStreetMap contributors (ODbL): heritage sites, coastline, rivers and place names via OpenFreeMap', 'AWS Open Data Terrain Tiles (Terrarium) for the relief', 'Trade-partner notes: Chinese annals of the 1001 AD mission, as summarised in standard Philippine histories'] },
  { day: 7, slug: '10-minute-map', theme: '10 minute map', prompt: 'You have no more than 10 minutes to complete this map.', title: 'Nearest facilities', insight: 'Every part of the city coloured by its straight-line distance to the nearest facilities, with the same surface for clinics, fire stations, police and schools. Click anywhere to see which one is closest. Built in ten minutes, as the prompt asks.', sources: ['OpenStreetMap contributors (ODbL): facilities from the Day 1 data and the city boundary'] },
  { day: 8, slug: 'utopia', theme: 'Utopia', prompt: 'A map of something which could be.', title: '15-minute Butuan', insight: 'Where would new parks and clinics help most?', sources: ['OpenStreetMap'] },
  { day: 9, slug: 'urban-rural', theme: 'Urban-rural', prompt: 'Urban or rural. Cities and countryside.', title: 'Core to countryside', insight: 'A transect from city centre to hinterland.', sources: ['GHSL', 'ESA WorldCover'] },
  { day: 10, slug: 'prompting-only', theme: 'Prompting only', prompt: 'Make AI work for its money and produce something from start to finish in a chat window or on the command line.', title: 'Built by prompt', insight: 'Made entirely through chat, with the prompt log published.', sources: [], needsHuman: true },
  { day: 11, slug: 'sound', theme: 'Senses: Sound', prompt: 'How do you hear something? How do you map a soundscape?', title: 'Modeled road noise', insight: 'Modeled, not measured.', sources: ['OpenStreetMap'] },
  { day: 12, slug: 'power', theme: 'Power', prompt: 'Power as in nuclear power? Or physical power or influence? Power grid on a map?', title: 'The grid', insight: 'Lines, substations and plants.', sources: ['OpenStreetMap power=*'] },
  { day: 13, slug: 'interactions', theme: 'Interactions', prompt: 'Interactions between things, or maybe the result would be an interactive map?', title: 'Barangay to facility', insight: 'Who depends on what.', sources: ['OpenStreetMap'] },
  { day: 14, slug: 'borgesian', theme: 'Borgesian map', prompt: 'A map so detailed it becomes the territory.', title: 'Every building', insight: 'Footprints at 1:1.', sources: ['Overture Maps', 'OpenStreetMap'] },
  { day: 15, slug: 'inside-out', theme: 'Inside out', prompt: 'Inside out, upside down. Something on this map is not quite right.', title: 'South-up', insight: 'Land and sea swap places.', sources: ['OpenStreetMap'] },
  { day: 16, slug: 'collaborative', theme: 'Collaborative map', prompt: 'Do a map with a friend, colleague or a stranger.', title: 'Shared pin board', insight: 'Built together with a colleague.', sources: [], needsHuman: true },
  { day: 17, slug: 'light-dark', theme: 'Light & dark', prompt: 'Play with visual effects. What can you map with just light and shadows?', title: 'Shade by the hour', insight: 'Building shadows through the day.', sources: ['OpenStreetMap', 'SunCalc'] },
  { day: 18, slug: 'null', theme: 'NULL', prompt: '(no official prompt)', title: 'What is missing', insight: 'Where the data is empty.', sources: ['OpenStreetMap'] },
  { day: 19, slug: 'smell', theme: 'Senses: Smell', prompt: 'How do you map things which your nose can sense?', title: 'Smell plumes', insight: 'Wind-aware plume model, labeled as modeled.', sources: ['Open-Meteo', 'OpenStreetMap'] },
  { day: 20, slug: 'hexagons', theme: 'Hexagons', prompt: 'Hexagons, the good old bestagons.', title: 'Livability hexes', insight: 'User-weighted index on an H3 grid.', sources: ['H3', 'OpenStreetMap'] },
  { day: 21, slug: 'openstreetmap', theme: 'OpenStreetMap', prompt: 'The awesome data source for mapping. You can also use this day to edit OSM.', title: 'Mapping Butuan on OSM', insight: 'How OSM coverage grew.', sources: ['ohsome API'] },
  { day: 22, slug: 'projections', theme: 'Projections', prompt: 'The different ways of representing a globe on a flat surface.', title: 'Butuan in three projections', insight: 'Distortion compared.', sources: ['proj4js'] },
  { day: 23, slug: 'taste', theme: 'Senses: Taste', prompt: 'Food, drink or something else which you can taste.', title: 'Taste of Caraga', insight: 'Local specialties and where to eat.', sources: ['Wikidata', 'OpenStreetMap'] },
  { day: 24, slug: 'network', theme: 'Network', prompt: 'Route network, transit network, human network or something completely different.', title: 'Road network fragility', insight: 'Which bridge failing hurts most?', sources: ['OpenStreetMap'] },
  { day: 25, slug: 'is-this-a-map', theme: 'Is this a map?', prompt: 'Stretch the limits of maps and blend your map with an artwork.', title: 'River as tree', insight: 'Flow accumulation as generative art.', sources: ['Copernicus GLO-30 DEM'] },
  { day: 26, slug: 'water', theme: 'Water', prompt: 'About 71% of the Earth\'s surface. That wet thing, you know?', title: 'Rising river', insight: 'Raise the river and see who is exposed (screening only).', sources: ['Copernicus GLO-30 DEM', 'JRC Global Surface Water', 'WorldPop'] },
  { day: 27, slug: 'new-tool', theme: 'New tool', prompt: 'Try out a new tool in your mapmaking workflow.', title: 'DuckDB in the browser', insight: 'Spatial SQL on GeoParquet, client-side.', sources: ['Overture Maps'] },
  { day: 28, slug: 'feeling', theme: 'Senses: Feeling', prompt: 'How would you map a feeling?', title: 'Feels-like Butuan', insight: 'A composite of heat, shade, noise and greenery.', sources: ['Landsat', 'earlier chapters'], needsHuman: true },
  { day: 29, slug: 'raster', theme: 'Raster', prompt: 'Do something cool with pixels.', title: 'Land cover swipe', insight: 'Ten years of change.', sources: ['ESA WorldCover', 'Sentinel-2'] },
  { day: 30, slug: 'pen-paper', theme: 'Pen & paper', prompt: 'Do an analogue map with pen and paper.', title: 'Sketch, scanned', insight: 'Hand-drawn, georeferenced, overlaid.', sources: [], needsHuman: true },
];

// Auto-discover built chapters: any folder src/days/dayNN-*/index.tsx is picked up.
const modules = import.meta.glob<{ default: DayComponent }>('./day*/index.tsx');

const lazyByDay = new Map<number, React.LazyExoticComponent<DayComponent>>();
for (const [path, loader] of Object.entries(modules)) {
  const m = path.match(/\.\/day(\d{2})-/);
  if (m) lazyByDay.set(Number(m[1]), lazy(loader));
}

export const DAYS: DayEntry[] = META.map((d) => ({
  ...d,
  Component: lazyByDay.get(d.day) ?? null,
}));

export const getDay = (n: number) => DAYS.find((d) => d.day === n);
export const builtCount = DAYS.filter((d) => d.Component).length;
