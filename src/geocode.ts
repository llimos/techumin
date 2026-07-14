/** Address search via Nominatim (OpenStreetMap). */

export interface GeocodeResult {
  lat: number;
  lon: number;
  displayName: string;
}

export async function geocode(query: string): Promise<GeocodeResult[]> {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding failed: ${res.status}`);
  const data: { lat: string; lon: string; display_name: string }[] = await res.json();
  return data.map((r) => ({
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    displayName: r.display_name.replace('Judea and Samaria, Palestinian Territories', 'Judea and Samaria, Israel'),
  }));
}
