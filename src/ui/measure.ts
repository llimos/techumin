/** Two-point measuring tool: a map control toggles click-click distance lines. */

import L from 'leaflet';

const RULER_SVG = `
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <g transform="rotate(-45 12 12)">
      <rect x="2" y="8" width="20" height="8" rx="1.5"
        fill="none" stroke="currentColor" stroke-width="1.8" />
      <path d="M6 8v3.5 M10 8v3.5 M14 8v3.5 M18 8v3.5"
        stroke="currentColor" stroke-width="1.4" />
    </g>
  </svg>`;

export class MeasureTool {
  active = false;

  private map: L.Map;
  private amahM = 0.48;
  private layer = L.layerGroup();
  private button!: HTMLElement;
  private start: L.LatLng | null = null;
  private preview: L.Polyline | null = null;
  private previewLabel: L.Tooltip | null = null;
  private line: L.Polyline | null = null;
  private lineMeters = 0;

  constructor(map: L.Map) {
    this.map = map;
    this.layer.addTo(map);

    const MeasureControl = L.Control.extend({
      onAdd: () => {
        const div = L.DomUtil.create('div', 'leaflet-bar');
        const a = L.DomUtil.create('a', 'measure-toggle', div);
        a.href = '#';
        a.title = 'Measure distance';
        a.setAttribute('role', 'button');
        a.setAttribute('aria-label', 'Measure distance');
        a.innerHTML = RULER_SVG;
        L.DomEvent.on(a, 'click', (e) => {
          L.DomEvent.stop(e);
          this.toggle();
        });
        this.button = a;
        return div;
      },
    });
    new MeasureControl({ position: 'topleft' }).addTo(map);

    map.on('click', this.onClick, this);
    map.on('mousemove', this.onMove, this);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.active) this.toggle();
    });
  }

  /** Set the amah length (meters); a displayed measurement is re-labelled. */
  setAmahMeters(amahM: number): void {
    this.amahM = amahM;
    if (this.line) this.line.setTooltipContent(this.format(this.lineMeters));
  }

  toggle(): void {
    this.active = !this.active;
    this.button.classList.toggle('measure-active', this.active);
    this.map.getContainer().classList.toggle('measuring', this.active);
    if (!this.active) this.clear();
  }

  private format(meters: number): string {
    const amot = meters / this.amahM;
    return `${Math.round(meters).toLocaleString()} m · ${Math.round(amot).toLocaleString()} amot`;
  }

  private onClick(e: L.LeafletMouseEvent): void {
    if (!this.active) return;
    if (!this.start) {
      this.clear();
      this.start = e.latlng;
      L.circleMarker(e.latlng, {
        radius: 4,
        color: '#16a085',
        fillColor: '#fff',
        fillOpacity: 1,
        weight: 2,
      }).addTo(this.layer);
      this.preview = L.polyline([e.latlng, e.latlng], {
        color: '#16a085',
        weight: 2,
        dashArray: '6 4',
        interactive: false,
      }).addTo(this.layer);
      this.previewLabel = L.tooltip({
        className: 'measure-label',
        direction: 'top',
        offset: [0, -8],
      })
        .setLatLng(e.latlng)
        .setContent(this.format(0))
        .addTo(this.map);
    } else {
      const meters = this.map.distance(this.start, e.latlng);
      this.removePreview();
      this.line = L.polyline([this.start, e.latlng], { color: '#16a085', weight: 3 })
        .bindTooltip(this.format(meters), {
          permanent: true,
          direction: 'top',
          offset: [0, -6],
          className: 'measure-label',
        })
        .addTo(this.layer);
      this.lineMeters = meters;
      L.circleMarker(e.latlng, {
        radius: 4,
        color: '#16a085',
        fillColor: '#fff',
        fillOpacity: 1,
        weight: 2,
      }).addTo(this.layer);
      this.start = null;
    }
  }

  private onMove(e: L.LeafletMouseEvent): void {
    if (!this.active || !this.start || !this.preview) return;
    this.preview.setLatLngs([this.start, e.latlng]);
    this.previewLabel
      ?.setLatLng(e.latlng)
      .setContent(this.format(this.map.distance(this.start, e.latlng)));
  }

  private removePreview(): void {
    this.preview?.remove();
    this.preview = null;
    this.previewLabel?.remove();
    this.previewLabel = null;
  }

  private clear(): void {
    this.removePreview();
    this.layer.clearLayers();
    this.start = null;
    this.line = null;
  }
}
