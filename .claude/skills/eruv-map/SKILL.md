---
name: eruv-map
description: Turn a published eruv map image (satellite poster or drawn street map) plus one known coordinate into lat/lon polygons, as GeoJSON, with a verification overlay
---

# Eruv map → polygons

Community eruv maps are pictures. This turns one into geometry — a polygon
per eruv, contiguous eruvin merged, unconnected ones kept apart.

Run everything from the repo root. No installs: `playwright-core`, `leaflet`
and `@turf/turf` are already in `node_modules`, and all pixel work happens
inside headless Edge (`lib/cv.js`) because the machine has no image library.
Put working files in the session scratchpad; `$W` below is that directory.
**Only the browser has network access here** — every script that fetches goes
through the page, so don't reach for `curl`-in-node or `fetch` in a helper.

## 0. Which style is it?

Read the image first. Everything downstream forks on this:

| | **Photo poster** | **Drawn map, fills** | **Drawn map, loops** |
| --- | --- | --- | --- |
| Base | satellite/aerial photo | vector street map | printed city map, often photographed |
| Eruvin drawn as | coloured **lines** | coloured **area fills** | nested coloured **loops** |
| Trace with | `--mode=outline` | `--mode=fill` | `--mode=outline --by=colour --holes` |
| Georeference with | `align.mjs` + `pair.mjs` | `junction.mjs` intersections | `junction.mjs --junctions` |
| Example | Beit Shemesh Ramah Gimmel | Bnei Brak Ramat Elchanan | Beitar Illit |

Go by what encloses the eruv; maps mix these freely (Bnei Brak has fills *and*
boundary lines). All routes end at the same `georef → project → overlay`.

## 1. Fetch and frame

`curl -o $W/poster.png <url>` (WebFetch cannot carry binary), then Read it.
Decide the **map crop** — the rectangle of actual map, excluding title,
sidebar text and footer — and check it:

```
node .claude/skills/eruv-map/crop.mjs $W/poster.png --crop=545,308,1490,955 --zoom=1 --grid=100 --out=$W/cropcheck.png
```

The grid labels are original-image pixels, so this doubles as the ruler for
everything below. Include the map right up to its frame — an eruv the poster
cuts off still needs that frame edge (`--edges=closed`).

## 2. Pick the colours

```
node .claude/skills/eruv-map/palette.mjs $W/poster.png --crop=... --top=20
```

Hue histogram over the saturated pixels, plus a swatch strip. Write the eruv
colours to `$W/colours.json`:

```json
[{ "name": "yellow", "hue": 55, "dHue": 15, "sMin": 0.35, "lMin": 0.3, "lMax": 0.85 }]
```

Print colours are duller than they look — Beit Shemesh's green line is only
S=0.39, so `sMin` around 0.3 is right and 0.45 loses it. Area **fills** are
paler still (S≈0.2, L≈0.7): set `sMin` low and `lMin` high for those, and
check the fills against the map's own background tint (Bnei Brak's
non-eruv blocks are a beige hue 25 that must not be selected). If a colour is
missing from the histogram, re-run `palette.mjs` on a small crop over it.

The same colour is often reused by unconnected eruvin — colour separates ink
from base map, it does not identify an eruv.

## 3. Trace

```
# photo poster, eruvin drawn as lines
node .claude/skills/eruv-map/trace.mjs $W/poster.png --crop=... --colours=$W/colours.json \
     --edges=closed --out=$W/traces.json --debug=$W/trace-debug.png

# drawn map, eruvin as filled areas
node .claude/skills/eruv-map/trace.mjs $W/poster.png --crop=... --colours=$W/colours.json \
     --mode=fill --out=$W/traces.json --debug=$W/trace-debug.png
```

**outline mode** unions all eruv colours into one stroke mask, drops blobs too
small to be a drawn line (`--minStroke=60` bbox diagonal — this is what
rejects red roofs and pool tiles), dilates (`--dilate=3`) to bridge the gaps
where labels cut the lines, and then takes the **enclosed regions** of the
non-stroke pixels. That is what makes an eruv work whose own line is open and
closes only against its neighbour's. Faces are then grown back into the
dilation halo, all at once so none pours through a real gap and swallows its
neighbour.

**fill mode** masks each colour separately, closes it (`--close=4`) to swallow
the streets, text and building outlines printed on top, and traces the
connected regions.

**`--by=colour`** runs outline mode once per colour instead of on the union.
Use it when the map draws **nested** boundaries — Beitar has a red outer
perimeter and a purple inner one — since the union would only give you the
ring between them. If one colour then fails to close (Beitar's purple is
interrupted where it coincides with the red), run that colour from the union
pass instead, where the neighbouring line seals it, and take the face whose
walls are mostly its colour. Combining faces from two runs into one
`traces.json` is fine; `project.mjs` only reads `faces`.

**`--holes`** subtracts the areas a boundary loops around to exclude: Beitar's
wadi, the blocks its inner perimeter cuts out. Opt-in, because an area
enclosed by another is sometimes a hole and sometimes a separate eruv drawn
inside a bigger one — only the map says which.

Both modes: `--minArea=0.002` (fraction of the crop) drops text counters and
specks.

**Read `trace-debug.png` before continuing.** It shows the surviving ink in
white with the numbered areas over it. Every numbered area must be a real eruv
and every eruv must have a number. Two failures look distinct:

- *An expected eruv is missing entirely* → its loop leaks. Check the white ink
  for breaks, and check that the **crop** contains the whole loop — a line
  that runs out of the crop leaks through the frame and its interior is lost.
  Raise `--dilate` to bridge real breaks.
- *A false area appears* → the map's own shading. Note the id and pass
  `--drop=` to `project.mjs` rather than retracing.

## 4a. Georeference a photo poster

Render a reference at a known extent, then match it automatically:

```
node .claude/skills/eruv-map/reference.mjs --centre=31.70445,34.98682 --zoom=16.1 \
     --size=1600x1050 --out=$W/ref.png --json=$W/ref.json
node .claude/skills/eruv-map/align.mjs $W/poster.png $W/ref.png --crop=... \
     --out=$W/align.json --check=$W/align-check.png
```

`reference.mjs` uses Esri World Imagery through Leaflet and records the corner
lat/lons Leaflet itself reports — that is what makes reference pixels
convertible to ground coordinates. Pick a zoom whose coverage comfortably
contains the poster.

`align.mjs` searches scale, rotation and translation, scoring how much more
often the poster's edge pixels land on reference edges than its flat pixels
do, on *binary* edges with the drawn-on pixels masked out.

**Read `align-check.png`** — the poster warped onto the reference at half
opacity; the road networks must coincide. Don't trust the score alone: it is a
hit-rate difference that falls at finer pyramid levels, and 0.25 with a clean
overlay beats 0.35 with a bad one. If it is wrong, widen `--scale=lo,hi`
(poster px measured in reference px) and `--rot=lo,hi`.

The fit is a similarity and lands within ~10 m — on Beit Shemesh it was biased
~9 m north–south. Control points fix that and are the only real accuracy
check. `pair.mjs` shows the same spot from both images side by side, each with
its own grid and a crosshair at the aligned position:

```
node .claude/skills/eruv-map/pair.mjs $W/poster.png $W/ref.png --align=$W/align.json \
     --at=1658,476 --size=180 --zoom=3 --out=$W/pair1.png
```

Read it and note the feature's centre in **both** panels. Roundabouts are
ideal. Take 4–6 spread across the map (corners matter most) into
`$W/points.json`:

```json
[{ "name": "roundabout NE", "poster": [1658.7, 486.0], "ref": [1000.5, 270.5] }]
```

To find candidates, read a spot in the reference and invert the alignment:
`poster = posterCentre + (ref − refCentre) / scale`; skip anything landing on
the poster's sidebar.

## 4b. Georeference a drawn map

`align.mjs` is useless here — an OSM raster and a hand-drawn map share no edge
structure (it scored 0.07 on Bnei Brak). Use the street names the map prints:

```
node .claude/skills/eruv-map/junction.mjs --centre=32.08486,34.84449 --list
```

One Overpass request fetches the street network; everything after is local.
Pick pairs of streets that visibly cross on the map, spread over it, and put
them in `$W/pairs.json` **with the Write tool** — Hebrew through the shell is
a trap, both for quoting and for bidirectional reordering:

```json
[["זומא", "אלימלך"], ["פרדו", "אלימלך"], ["אבני", "כהנמן"], ["ריינס", "אונקלוס"]]
```

Names are matched as regexes, so one distinctive word is safest ("כהנמן", not
"הרב כהנמן").

Where OSM coverage is patchy, guessing pairs wastes time — in Beitar only 1 of
12 guesses resolved, because the ways there mostly do not share nodes. Ask
instead for the junctions that actually exist and pick from the list:

```
node .claude/skills/eruv-map/junction.mjs --centre=... --junctions=45
```

Then:

```
node .claude/skills/eruv-map/junction.mjs --centre=... --batch=$W/pairs.json > $W/junctions.json
```

Each hit comes back as `{ name, latlon, poster: null }`. Fill in the `poster`
pixel of each junction by cropping the map around it (`crop.mjs`, zoom 3) and
reading where the two centrelines cross — ±5 px is fine. `FAIL … never closer
than N m` means those streets don't actually meet; pick another pair.

## 5. Fit the transform

```
node .claude/skills/eruv-map/georef.mjs $W/points.json --ref=$W/ref.json \
     --align=$W/align.json --out=$W/transform.json
```

`--ref` is only needed for points given as reference *pixels*; points that
already carry a `latlon` (from `junction.mjs`) need neither `--ref` nor
`--align`. With no points at all, `--align` alone is used.

A useful bootstrap when you have no alignment and cannot find junctions on the
map: fit `--kind=similarity` from **2** points, then invert it to predict where
other known junctions should fall on the map, crop there, and read them. Each
new point tightens the next prediction. (The similarity fit tries both a
rotation and a rotation-with-mirror, since image y grows downwards while
northing grows up, and keeps whichever matches.)

Residuals print in ground metres. With 3 points the affine fit is exact and
tells you nothing — use 4+. Expect roughly your own reading error: Beit Shemesh
gave RMS 0.25 m from roundabout centres, Bnei Brak RMS 1.9 m from junction
crossings. One point with a much larger residual was misread; re-read or drop
it. `--use=align` ignores the points, `--kind=similarity` constrains the fit
when points are few or clustered.

## 6. Project and merge

```
node .claude/skills/eruv-map/project.mjs $W/traces.json --transform=$W/transform.json \
     --names=$W/names.json --drop=180 --merge=15 --out=$W/eruvin.geojson
```

`names.json` maps area id → the label read off the map (`{"3": "רמה ג' 1"}`);
the legend is the only place the eruvin are named, so it is worth doing.

Merging uses the pixel gaps `trace.mjs` measured, converted to metres, and
those gaps cluster hard: Beit Shemesh's shared street walls came out at 1–9 m
and its genuine separations at 20 and 33 m, so anything from ~12 to ~19 m gave
the same answer. **Read the printed gap list and put `--merge` in the empty
band between the clusters.** `--merge=0` keeps every area separate, which is
what you want when the map's areas are distinct eruvin that merely abut.

Outputs: `eruvin.geojson` (merged) and `eruvin-raw.geojson` (per traced area).
Keep both — the raw one is where the individually named eruvin live.

## 6b. Check the fit against the road network

```
node .claude/skills/eruv-map/register.mjs $W/traces.json --centre=lat,lon \
     --roads=$W/roads.json --check=$W/transform.json
```

Reports how much of the traced boundary lands on a street running the same
way. It needs no control points, so it is the one automatic quality signal
available for every map. Measured against fits whose true error is known:

| map | true error | median distance to a road | within 20 m |
| --- | --- | --- | --- |
| Beit Shemesh | 0.25 m | 11.8 m | 71% |
| Bnei Brak | 1.9 m | 22.5 m | 45% |
| Beitar | ~100 m | 41.6 m | 25% |

The ordering is right, but the absolute level depends on the map: Bnei Brak's
boundary follows the backs of blocks rather than centrelines, so a *correct*
fit still reads 45%. Use it to rank maps for review, not as a pass mark.
A median above ~35 m deserves a look.

`--seed=transform.json` refines an existing fit by ICP against the roads
instead of scoring it. **Only worth it where streets curve.** Measured:
seeded from the ~9 m automatic alignment on Beit Shemesh it converged to 9.5 m
RMS at the control points (no better than its seed — a drawn boundary sits
metres off the centreline, which is the floor). On Bnei Brak's regular grid it
*degraded* a 1.9 m fit to 45 m, walking one block over, so the tool now keeps
the seed unless it can beat it. Global search without a seed is not usable at
all: decoy alignments score within 6% of the truth.

`evaluate.mjs points.json --transform=t.json [--vs=other.json]` gives the real
number — ground error in metres at control points — and compares two fits.

## 7. Verify

```
node .claude/skills/eruv-map/overlay.mjs $W/eruvin-raw.geojson --basemap=osm --size=1500x1000 --out=$W/overlay-raw.png
```

Read it and compare to the map street by street: each area must follow the
same roads, and the merged grouping must match. Use `--basemap=osm` for a
drawn source (street names to compare against) and the default Esri imagery
for a photo one. Do the raw file first — that is where a mistraced or misnamed
area shows up. Disagreement is nearly always the control points, not the
tracing.

## Accuracy

Beit Shemesh (photo): 1.32 × 1.34 m/px, rotation −0.02°, control points
consistent to 0.43 m. Bnei Brak (drawn): 0.489 m/px, rotation 0.36°, RMS
1.9 m. Beitar (photographed print): 2.47 m/px, rotation 8.5°, but only 2
control points — the shape lands on the city correctly while local error is
of the order of 100 m. **Say which of these you got.** The tracing is the easy
part; the georeferencing is what varies, and a plausible-looking overlay can
still be 100 m out.

In outline mode the polygon sits on the drawn line's inner edge, so it runs
about half a stroke width inside the eruv; in fill mode it sits on the fill's
edge. A photographed poster adds its own distortion — perspective, and a
curled corner that no global transform can absorb. Treat the output as good to
roughly a stroke width *plus* whatever the control points say, and never as a
halachic boundary.
