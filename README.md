# Butuan Unfolded

#30DayMapChallenge 2026: one app, 30 chapters, open data for Butuan City and Caraga.
Through-line: how water, heat, access and people interact.

## Run locally

```bash
npm install
npm run dev
```

## Deploy to Vercel

1. Push this folder to a GitHub repo.
2. In Vercel: Add New > Project > import the repo. The Vite preset is detected automatically (`vercel.json` already handles SPA routing and caching).
3. Every push to `main` redeploys. Each day is a permalink, e.g. `/day/1`.

## Add a chapter

1. Create `src/days/dayNN-slug/index.tsx` with a default export `({ map }) => ...`. It is picked up automatically.
2. Fill in its title, insight and sources in `src/days/registry.ts`.
3. Put data in `public/data/` (small files) or external storage (large PMTiles/COGs), produced by a script in `pipeline/`.

Chapters add layers on mount and must remove them on unmount (see `day01-points`).

## Data rules

- Fetch data in `pipeline/` scripts, commit the static output. The deployed app never calls live APIs.
- Record source, licence and fetch date for every dataset.
- Keep OSM attribution (ODbL) visible.

## Day 1 data

```bash
python pipeline/01_osm_facilities.py
```

Fetches the Butuan City boundary (Nominatim) and the facilities inside it (Overpass). Standard library only, Python 3.10+.
