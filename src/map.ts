/** Leaflet map with one overlay layer per pipeline output. */

import L from 'leaflet';
import { toPng } from 'html-to-image';
import type { Position } from 'geojson';
import type { DataEdges, LatLon, Poly } from './types';
import type { PipelineOutputs } from './pipeline';
import { anyDataEdge } from './geo/dataEdges';
import { MeasureTool } from './ui/measure';
import { DEBUG } from './debug';

/**
 * A scale bar in amot, reusing the stock Scale control's measuring and
 * nice-number rounding; the amah length is set via setAmahMeters below.
 */
interface AmahScaleControl extends L.Control {
  _amahM?: number;
  _update?: () => void;
}

const AmahScale = (L.Control.Scale as any).extend({
  _addScales(_options: unknown, className: string, container: HTMLElement) {
    this._aScale = L.DomUtil.create('div', className, container);
  },
  _updateScales(maxMeters: number) {
    if (!this._amahM || !maxMeters) return;
    const maxAmot = maxMeters / this._amahM;
    const amot = this._getRoundNum(maxAmot);
    this._updateScale(this._aScale, `${amot} amot`, amot / maxAmot);
  },
});

export class TechumMap {
  readonly map: L.Map;
  private tiles: L.TileLayer;
  private marker: L.CircleMarker | null = null;
  private eruvMarker: L.Marker | null = null;
  private layers: Record<string, L.LayerGroup> = {};
  /** Highlight of the area where an eruv may be placed (not in the control). */
  private eruvZone: L.LayerGroup;
  private amahScale: AmahScaleControl;
  private measure: MeasureTool;

  onPick: (point: LatLon) => void = () => {};

  constructor(container: HTMLElement) {
    this.map = L.map(container).setView([31.778, 35.235], 15);
    // crossOrigin lets the report snapshot draw the tiles onto a canvas
    // without tainting it (the OSM tile server allows CORS).
    this.tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      crossOrigin: true,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.map);
    L.control.scale({ imperial: false }).addTo(this.map);
    this.amahScale = new AmahScale() as AmahScaleControl;
    this.amahScale.addTo(this.map);
    this.measure = new MeasureTool(this.map);

    const overlays: Record<string, L.LayerGroup> = {};
    const defs: [key: string, label: string, on: boolean][] = [
      ['buildings', 'Buildings', false],
      ['cities', 'Cities (raw clusters)', false],
      ['merged', 'Merged cities', true],
      ['squarings', 'Squaring (ribua)', true],
      ['keshet', 'Keshet/gam exclusion', true],
      ['shvita', 'Shvisa bounds', true],
      ['techum', 'Techum boundary', true],
    ];
    for (const [key, label, on] of defs) {
      const group = L.layerGroup();
      this.layers[key] = group;
      overlays[label] = group;
      if (on) group.addTo(this.map);
    }
    // City numbers are always populated (the report snapshot shows them
    // temporarily) but shown and offered in the control only in debug mode.
    this.layers['cityNumbers'] = L.layerGroup();
    if (DEBUG) {
      overlays['City numbers (debug)'] = this.layers['cityNumbers'];
      this.layers['cityNumbers'].addTo(this.map);
    }
    // On small screens the expanded layer list would cover most of the map.
    const collapsed = window.matchMedia('(max-width: 768px)').matches;
    L.control.layers({}, overlays, { collapsed }).addTo(this.map);
    this.eruvZone = L.layerGroup().addTo(this.map);

    this.map.on('click', (e: L.LeafletMouseEvent) => {
      if (this.measure.active) return;
      this.onPick({ lat: e.latlng.lat, lon: e.latlng.lng });
    });
  }

  /** Set the amah length (meters) used by the amot scale bar and measure tool. */
  setAmahMeters(amahM: number): void {
    this.amahScale._amahM = amahM;
    this.amahScale._update?.();
    this.measure.setAmahMeters(amahM);
  }

  setPoint(point: LatLon): void {
    if (this.marker) this.marker.remove();
    this.marker = L.circleMarker([point.lat, point.lon], {
      radius: 7,
      color: '#c0392b',
      fillColor: '#e74c3c',
      fillOpacity: 0.9,
    }).addTo(this.map);
  }

  /** Show the placed eruv as a bread marker; null removes it. */
  setEruvPoint(point: LatLon | null): void {
    if (this.eruvMarker) {
      this.eruvMarker.remove();
      this.eruvMarker = null;
    }
    if (!point) return;
    this.eruvMarker = L.marker([point.lat, point.lon], {
      icon: L.divIcon({ className: 'eruv-marker', html: '🍞', iconSize: [28, 28] }),
      interactive: false,
    }).addTo(this.map);
  }

  /** Highlight the area where the eruv may be placed; null clears it. */
  setEruvZone(zone: Poly | null): void {
    this.eruvZone.clearLayers();
    if (!zone) return;
    L.geoJSON(zone, {
      style: {
        color: '#f39c12',
        weight: 3,
        dashArray: '8 6',
        fillColor: '#f1c40f',
        fillOpacity: 0.12,
      },
      interactive: false,
    }).addTo(this.eruvZone);
  }

  /** Bread cursor over the map while placing an eruv. */
  setEruvCursor(on: boolean): void {
    this.map.getContainer().classList.toggle('eruv-placing', on);
  }

  render(outputs: PipelineOutputs): void {
    const set = (key: string, features: GeoJSON.Feature[] | undefined, style: L.PathOptions) => {
      const group = this.layers[key];
      group.clearLayers();
      if (!features?.length) return;
      L.geoJSON({ type: 'FeatureCollection', features } as GeoJSON.FeatureCollection, {
        style,
      }).addTo(group);
    };
    // Like set, but borders facing a side where the building data ran out are
    // drawn dotted — they may not be the real bounds.
    const setEdged = (
      key: string,
      items: { feature: Poly; edges: DataEdges }[] | undefined,
      style: L.PathOptions,
    ) => {
      const group = this.layers[key];
      group.clearLayers();
      for (const { feature, edges } of items ?? []) {
        if (anyDataEdge(edges)) addSplitStroke(group, feature, style, edges);
        else L.geoJSON(feature, { style }).addTo(group);
      }
    };

    set('buildings', outputs.fetched?.buildings, {
      color: '#7f8c8d',
      weight: 1,
      fillOpacity: 0.15,
    });
    set(
      'cities',
      outputs.citiesResult && [
        ...outputs.citiesResult.cities.map((c) => c.polygon),
        ...outputs.citiesResult.structures.map((c) => c.polygon),
      ],
      { color: '#f39c12', weight: 1, dashArray: '4 3', fillOpacity: 0.05 },
    );
    set('merged', outputs.merged?.map((c) => c.polygon), {
      color: '#d35400',
      weight: 2,
      fillOpacity: 0.08,
    });
    setEdged(
      'squarings',
      outputs.squarings?.map((s) => ({ feature: s.polygon, edges: s.dataEdges })),
      { color: '#8e44ad', weight: 2, dashArray: '8 4', fillOpacity: 0.04 },
    );
    set('keshet', outputs.squarings?.flatMap((s) => s.keshetCuts), {
      color: '#c0392b',
      weight: 1.5,
      dashArray: '2 5',
      fillOpacity: 0.15,
    });
    // With an eruv placed, the shvita/techum layers show only the eruv's, in
    // a purple scheme; the home outputs stay cached but are not drawn.
    const eruv = !!(outputs.eruvShvita || outputs.eruvTechum);
    const shvita = eruv ? outputs.eruvShvita : outputs.shvita;
    setEdged(
      'shvita',
      shvita && [{ feature: shvita.polygon, edges: shvita.dataEdges }],
      eruv
        ? { color: '#8e44ad', weight: 2, dashArray: '4 3', fillOpacity: 0.05 }
        : { color: '#2980b9', weight: 2, fillOpacity: 0.05 },
    );
    // The techum inherits the shvita's uncertainty: it is measured outward
    // from the shvita, so any side the shvita may fall short on, it may too.
    const techum = eruv ? outputs.eruvTechum : outputs.techum;
    setEdged(
      'techum',
      techum && shvita && [{ feature: techum, edges: shvita.dataEdges }],
      eruv
        ? { color: '#8e44ad', weight: 3, fillOpacity: 0.06 }
        : { color: '#27ae60', weight: 3, fillOpacity: 0.06 },
    );

    const numbers = this.layers['cityNumbers'];
    numbers.clearLayers();
    outputs.citiesResult?.cities.forEach((city, i) => {
      const center = L.geoJSON(city.polygon).getBounds().getCenter();
      L.marker(center, {
        icon: L.divIcon({
          className: 'city-debug-label',
          html: String(i + 1),
          iconSize: [26, 26],
        }),
        interactive: false,
      }).addTo(numbers);
    });

    const fit = outputs.eruvTechum ?? outputs.techum;
    if (fit) {
      this.map.fitBounds(L.geoJSON(fit).getBounds(), { padding: [24, 24] });
    }
  }

  /**
   * Snapshot the map for the printable report: fit the view to the given
   * polygon, show the city numbers, hide the interactive controls (keeping
   * the attribution and scale bars), wait for the tiles, and rasterize the
   * container to a PNG data URL. The previous view and layers are restored;
   * returns null when the capture fails (e.g. a tile that taints the canvas).
   */
  async captureReport(fit: Poly | null): Promise<string | null> {
    const container = this.map.getContainer();
    const center = this.map.getCenter();
    const zoom = this.map.getZoom();
    const numbers = this.layers['cityNumbers'];
    const numbersWereOn = this.map.hasLayer(numbers);
    container.classList.add('map-capturing');
    if (!numbersWereOn) numbers.addTo(this.map);
    try {
      if (fit) {
        const moved = new Promise<void>((resolve) => {
          this.map.once('moveend', () => resolve());
          setTimeout(resolve, 400); // fitBounds may be a no-op and never fire
        });
        this.map.fitBounds(L.geoJSON(fit).getBounds(), { padding: [24, 24], animate: false });
        await moved;
      }
      if (this.tiles.isLoading()) {
        await new Promise<void>((resolve) => {
          this.tiles.once('load', () => resolve());
          setTimeout(resolve, 8000); // don't hang the report on a slow tile
        });
      }
      return await toPng(container, { pixelRatio: 2 });
    } catch (err) {
      console.error('[techum] map capture failed', err);
      return null;
    } finally {
      container.classList.remove('map-capturing');
      if (!numbersWereOn) numbers.remove();
      this.map.setView(center, zoom, { animate: false });
    }
  }
}

/** Dash pattern marking a border that may not be the real bound. */
const UNCERTAIN_DASH = '2 8';

/**
 * Draw a polygon with its border split per side: fill as usual, then solid
 * polylines along edges facing reliable directions and dotted ones along
 * edges facing a side where the building data ran out.
 */
function addSplitStroke(
  group: L.LayerGroup,
  feature: Poly,
  style: L.PathOptions,
  edges: DataEdges,
): void {
  L.geoJSON(feature, { style: { ...style, stroke: false } }).addTo(group);
  const solid: L.PathOptions = { ...style, fill: false };
  const dotted: L.PathOptions = { ...solid, dashArray: UNCERTAIN_DASH };
  const polys =
    feature.geometry.type === 'Polygon'
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates;
  for (const rings of polys) {
    for (const ring of rings) {
      for (const run of splitRuns(ring, edges)) {
        const latlngs = run.points.map(([lon, lat]) => [lat, lon] as L.LatLngTuple);
        L.polyline(latlngs, run.dotted ? dotted : solid).addTo(group);
      }
    }
  }
}

interface StrokeRun {
  points: Position[];
  dotted: boolean;
}

/**
 * Split a closed ring into maximal runs of edges by whether each edge faces
 * an uncertain side. An edge belongs to the compass side its outward normal
 * is nearest to, so rotated squarings, keshet cuts, and rounded Rema corners
 * all classify sensibly.
 */
function splitRuns(ring: Position[], edges: DataEdges): StrokeRun[] {
  const m = ring.length - 1; // last point repeats the first
  if (m < 3) return [{ points: ring, dotted: false }];

  // Ring orientation (shoelace sign) decides which normal points outward.
  let area = 0;
  for (let i = 0; i < m; i++) {
    area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  const sign = area >= 0 ? 1 : -1;
  const cosLat = Math.cos((ring[0][1] * Math.PI) / 180);

  const classes: boolean[] = [];
  for (let i = 0; i < m; i++) {
    const dx = (ring[i + 1][0] - ring[i][0]) * cosLat; // meters-proportional east
    const dy = ring[i + 1][1] - ring[i][1]; // north
    const nx = sign * dy;
    const ny = -sign * dx;
    const side = Math.abs(nx) > Math.abs(ny) ? (nx > 0 ? 'e' : 'w') : ny > 0 ? 'n' : 's';
    classes.push(edges[side]);
  }
  if (classes.every((c) => c === classes[0])) return [{ points: ring, dotted: classes[0] }];

  // Start at a class boundary so no run is split across the ring seam.
  let start = 0;
  while (classes[(start - 1 + m) % m] === classes[start]) start++;
  const runs: StrokeRun[] = [];
  let i = start;
  do {
    const cls = classes[i];
    const points: Position[] = [ring[i]];
    let j = i;
    while (classes[j] === cls) {
      points.push(ring[(j + 1) % m]);
      j = (j + 1) % m;
    }
    runs.push({ points, dotted: cls });
    i = j;
  } while (i !== start);
  return runs;
}
