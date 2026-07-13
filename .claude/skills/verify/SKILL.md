---
name: verify
description: Drive the techumin web app headless to verify pipeline/geometry changes end-to-end
---

# Verifying techumin changes

Drive the real app headless; don't import pipeline modules directly.

## Build & launch

- `npm install` (fresh worktrees have no node_modules); `playwright-core` comes in via the `playwright` devDep.
- `npm run dev` in the background; parse the port from the log (5173 if free).
- `chromium.launch({ channel: 'msedge', headless: true })` — uses installed Edge, no browser download.

## Drive

- Navigate `http://localhost:PORT/?lat=..&lon=..&debug=1`, wait for `#status`, give the map ~3 s to settle, then `page.mouse.click` at the centre of the `#map` container's bounding box — the URL params centre the map but only a click picks the point and runs the pipeline. The sidebar offsets the map, so the URL point is at the **container** centre, not the viewport centre (clicking the viewport centre lands ~850 m west).
- Wait for `#status` text to become exactly `Done.` (allow 300 s — live map tiles + AWS terrain).
- With `?debug=1`, merge/pipeline decisions log to console as `[techum debug] ...` and `window.__techumOutputs` exposes every step's output (`fetched`, `citiesResult`, `merged`, `squarings`, `shvita`, `techum`, ...). Assert on those, not on Leaflet layers.

## Synthetic cities (geometry rules)

- Intercept Overpass: `page.route('**/api/interpreter*', route => route.fulfill({ json: osm }))` — the app POSTs to `https://<mirror>/api/interpreter`; one intercept serves all mirrors. Map tiles/elevation stay real.
- OSM JSON shape: `{ version: 0.6, elements: [{type:'node',id,lat,lon}, ..., {type:'way',id,nodes:[...ids, ids[0]],tags:{building:'yes'}}] }`.
- **A city needs ≥ 6 buildings** (`MIN_CITY_BUILDINGS`) — smaller clusters are "structures" and are ignored by merging. Use e.g. a 3×2 grid of 10×10 m buildings with 5 m gaps (intra-city gaps must stay < 70⅔ amot ≈ 33.9 m @ 48 cm).
- Flat terrain for tight distance assertions: 31.72, 34.68 (Israel coastal plain) — rays come out ~959 m of the 960 m budget.
- Metres→degrees at that latitude: ÷110882 for lat, ÷94787 for lon.
- `.claude/skills/verify/verify-triangle.mjs` is a working example (triangle-rule scenarios); copy it to the repo root and run `node verify-triangle.mjs <in|out|edge|behindA>`.
- `.claude/skills/verify/verify-havlaah.mjs` runs from its own directory (`PORT=.. node .claude/skills/verify/verify-havlaah.mjs <maParallel|remaParallel|remaFull>`) and self-asserts havla'ah widths by intersecting horizontal lines with the techum ring.
- `PORT=.. node .claude/skills/verify/verify-squaring.mjs <square|straight>` self-asserts the perceptual squaring tolerance: a jagged 20°-rotated near-square city (tolerant already-square branch) and a wobbly straight-side city with `chazonIshStraightSide` enabled (injected via localStorage `techumin-settings`) must both square at ~20°.

## Gotchas

- After each run the map `fitBounds` to the techum — for a *second* click, anchor to the red home CircleMarker (`path[stroke="#c0392b"]`), not the viewport centre.
- In-app Nominatim search is unreliable under headless Edge — set position via URL params instead.
- `gh` CLI is not installed on this machine; `git push` prints the GitHub PR URL — hand that to the user.
