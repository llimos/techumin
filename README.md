# Techumin — Techum Shabbat Calculator

A web app that estimates the techum Shabbat around any point, drawn on an
interactive map. Everything runs client-side in the browser — there is no
server component; the app only calls public data services (OpenStreetMap and
AWS Terrain Tiles) directly.

**Live:** https://llimos.github.io/techumin/

> **Disclaimer:** This tool estimates techum boundaries for reference only.
> The results depend on the completeness of OpenStreetMap data and on
> geometric approximations, and many halachic factors (karpef, water bodies,
> mechitzot, eruvin) are not considered. Consult a rabbi for practical psak.

## Usage

Click anywhere on the map (or search for an address, or use your location) to
set the point. The sidebar lets you choose between halachic opinions; changing
an opinion recalculates only from the first affected step. Intermediate
results (buildings, city clusters, merged cities, squarings, shvita bounds)
can be toggled as map layers, and each step logs its timing and output to the
browser console.

## Calculation steps

The calculation is a pipeline of six steps, each in its own module under
`src/steps/`. Every step's output is cached, so a settings change re-runs only
from the first step that consumes the changed setting.

### 1. Fetch buildings

Query the Overpass API (with mirror fallback) for all `building` ways and
relations within a square around the chosen point (configurable, default
3 km from the point to each edge),
and identify the building enclosing the point, if any. A warning is shown when
buildings reach the edge of the loaded area, since the city may extend beyond
it.

### 2. Find cities

Cluster buildings into halachic cities: buildings separated by gaps of at most
**70⅔ amot** belong to the same city (each building's outline is dilated by
half the gap and the dilations are unioned, so buildings within the gap merge
into one outline). A cluster needs at least **6 buildings** to count as a
city; smaller clusters remain standalone structures. The amah length is
configurable: R' Chaim Naeh (48 cm), R' Moshe Feinstein (54 cm), Chazon Ish
(57.6 cm), or custom.

### 3. Merge cities

Two phases:

- **Proximity:** two cities at most **141⅓ amot** apart merge into one
  (transitively), to completion.
- **Triangle (ro'in) rule**, checked between the already-merged cities: given
  cities A, B and C, where B is within **2000 amot** of both A and C, and the
  gap between A and C is at most **282⅔ amot plus B's width** (measured along
  the A–C direction), A and C merge — B is viewed as if moved into the gap
  between them, so it need not physically sit between them. The rule does not
  apply if the line between A and C (along their shortest gap) passes through
  a building of a city other than B. *Configurable:* whether B itself is
  absorbed into the merged city, and whether the rule still applies when B is
  wider than the A–C gap — it merges according to the Gr"a, but not according
  to the Tur and Chazon Ish.

### 4. Square the city (ribua ha'ir)

Each city is squared off to a rectangle, and the rectangle's angle is recorded
for the techum measurement:

- **Already-oblong check:** if the city already fills its minimum-area
  bounding rectangle (at any angle), it is considered squared at that angle.
- **Straight side** (*configurable, Chazon Ish*): if one side of the city is a
  straight line along the city's entire length, square along that side's
  angle.
- Otherwise the city is squared **true north–south**.

The squaring rectangle is the bounding box of the actual building vertices at
the recorded angle. Then:

- **Keshet/gam exclusion:** a concave region is measured along its true chord
  — the segment between the two horns of the bow, at whatever angle it runs.
  If the chord spans at least **4000 amot** and the region runs deeper than
  **2000 amot** perpendicular to the chord before reaching the city, it is
  excluded from the squaring. *Configurable:* exclude the entire keshet, or
  only the part where its width (parallel to the chord) exceeds 2000 amot.
- **Rema extra** (*configurable*): add an extra 70⅔ amot around the squaring.

### 5. Shvita bounds

Determine the area from which the techum is measured:

- Point inside a city → that city's squaring (and its angle).
- Otherwise, point inside a squaring (a squared-off corner region) → that
  squaring; if squarings of several cities overlap there, the nearest city's.
- Otherwise, point inside a building → the building's north–south bounding
  rectangle.
- Otherwise → a square of 4 amot around the point. *Configurable:* 4 amot in
  each direction, or 4 amot total.

### 6. Measure the techum

From each corner of the shvita bounds, measure **2000 amot** outward in the
two axis directions of the recorded angle. Each ray is measured with the
gradient rule, using elevation data sampled along the way:

- Ground with a slope shallower than **1:3.6** is measured along the surface.
- Steeper ground is measured as the crow flies — unless it descends and ends
  more than 2000 amot below the start, in which case it is measured along the
  surface after all.

Where the two rays pointing the same direction from adjacent corners end at
unequal distances, *configurable:* extend the shorter line to match the
longer, or join the endpoints on a diagonal. Finally the sides are joined and
extended to their intersections, so the techum includes full (squared)
corners. Where a keshet/gam exclusion indents the squaring deeper than the
measured distance, the techum follows the indented shape at the measured
side distances.

### Eruv techumin

After a techum is calculated, an eruv techumin can be placed on the map (the
sidebar button highlights the area where it may be placed — *configurable:*
within 2000 amot of the start point, or anywhere within the city's techum;
even according to the lenient opinion, a warning notes that most poskim do
not allow returning to the start point when the eruv is beyond 2000 amot from
it). The shvita then moves to the eruv: steps 5–6 re-run from the eruv's
location under the same rules (in a city → the city's squaring; in a building
→ the building; open country → 4 amot), while the original calculation stays
cached, so removing the eruv restores it instantly.

## Configurable opinions

| Setting | Options (default first) | Recalculates from |
|---|---|---|
| Amah length | R' Chaim Naeh 48 cm / R' Moshe Feinstein 54 cm / Chazon Ish 57.6 cm / custom | Step 2 |
| Triangle rule: third city absorbed? | yes / no | Step 3 |
| Triangle rule: middle city wider than the gap | does not merge (Tur, Chazon Ish) / merges (Gr"a) | Step 3 |
| Chazon Ish straight-side squaring | off / on | Step 4 |
| Keshet/gam exclusion extent | entire keshet / only past 2000 amot | Step 4 |
| Rema extra 70⅔ amot | off / on | Step 4 |
| No-structure fallback | 4 amot each direction / 4 amot total | Step 5 |
| Unequal measurement lines | extend shorter / join on diagonal | Step 6 |
| Eruv techumin placement | within 2000 amot of the start point / anywhere in the city's techum | Eruv re-measure |
| Data radius (non-halachic) | 3 km default | Step 1 |

## Data sources

- **Buildings:** OpenStreetMap via the [Overpass API](https://overpass-api.de/)
- **Geocoding:** [Nominatim](https://nominatim.org/)
- **Elevation:** [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
  (Terrarium PNGs, ~10–30 m resolution)
- **Map tiles:** OpenStreetMap

## Known limitations

- City shapes are only as good as OSM building coverage in the area.
- Measurement lines are straight; obstacles, water and karpef are ignored.
- Keshet/gam and oblong detection use geometric tolerances, not psak-grade
  judgment.
- Terrain inside a keshet indentation is not measured separately — the four
  globally measured side distances are used; the Rema expansion of
  non-rectangular squarings is a geometric approximation (round corners).
- Dense areas (thousands of buildings) can take a minute or two to compute,
  and the default 3 km radius may truncate large cities — a warning is shown.

## Development

```sh
npm install
npm run dev      # dev server
npm run build    # type-check + production build
npm run build-gh # build with the GitHub Pages base path
```

Built with Vite + vanilla TypeScript, [Leaflet](https://leafletjs.com/),
[Turf.js](https://turfjs.org/) and
[osmtogeojson](https://github.com/tyrasd/osmtogeojson). Pushes to `master`
deploy to GitHub Pages automatically via `.github/workflows/gh-pages.yml`.
