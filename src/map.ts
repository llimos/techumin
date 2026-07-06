/** Leaflet map with one overlay layer per pipeline output. */

import L from 'leaflet';
import type { LatLon } from './types';
import type { PipelineOutputs } from './pipeline';
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
  private marker: L.CircleMarker | null = null;
  private layers: Record<string, L.LayerGroup> = {};
  private amahScale: AmahScaleControl;

  onPick: (point: LatLon) => void = () => {};

  constructor(container: HTMLElement) {
    this.map = L.map(container).setView([31.778, 35.235], 15);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.map);
    L.control.scale({ imperial: false }).addTo(this.map);
    this.amahScale = new AmahScale() as AmahScaleControl;
    this.amahScale.addTo(this.map);

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
    if (DEBUG) defs.push(['cityNumbers', 'City numbers (debug)', true]);
    for (const [key, label, on] of defs) {
      const group = L.layerGroup();
      this.layers[key] = group;
      overlays[label] = group;
      if (on) group.addTo(this.map);
    }
    L.control.layers({}, overlays, { collapsed: false }).addTo(this.map);

    this.map.on('click', (e: L.LeafletMouseEvent) => {
      this.onPick({ lat: e.latlng.lat, lon: e.latlng.lng });
    });
  }

  /** Set the amah length (meters) used by the amot scale bar. */
  setAmahMeters(amahM: number): void {
    this.amahScale._amahM = amahM;
    this.amahScale._update?.();
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

  render(outputs: PipelineOutputs): void {
    const set = (key: string, features: GeoJSON.Feature[] | undefined, style: L.PathOptions) => {
      const group = this.layers[key];
      group.clearLayers();
      if (!features?.length) return;
      L.geoJSON({ type: 'FeatureCollection', features } as GeoJSON.FeatureCollection, {
        style,
      }).addTo(group);
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
    set('squarings', outputs.squarings?.map((s) => s.polygon), {
      color: '#8e44ad',
      weight: 2,
      dashArray: '8 4',
      fillOpacity: 0.04,
    });
    set('keshet', outputs.squarings?.flatMap((s) => s.keshetCuts), {
      color: '#c0392b',
      weight: 1.5,
      dashArray: '2 5',
      fillOpacity: 0.15,
    });
    set('shvita', outputs.shvita && [outputs.shvita.polygon], {
      color: '#2980b9',
      weight: 2,
      fillOpacity: 0.05,
    });
    set('techum', outputs.techum && [outputs.techum], {
      color: '#27ae60',
      weight: 3,
      fillOpacity: 0.06,
    });

    if (DEBUG) {
      const group = this.layers['cityNumbers'];
      group.clearLayers();
      outputs.citiesResult?.cities.forEach((city, i) => {
        const center = L.geoJSON(city.polygon).getBounds().getCenter();
        L.marker(center, {
          icon: L.divIcon({
            className: 'city-debug-label',
            html: String(i + 1),
            iconSize: [26, 26],
          }),
          interactive: false,
        }).addTo(group);
      });
    }

    if (outputs.techum) {
      this.map.fitBounds(L.geoJSON(outputs.techum).getBounds(), { padding: [24, 24] });
    }
  }
}
