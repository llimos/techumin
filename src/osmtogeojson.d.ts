declare module 'osmtogeojson' {
  import type { FeatureCollection } from 'geojson';
  function osmtogeojson(data: unknown, options?: { flatProperties?: boolean }): FeatureCollection;
  export default osmtogeojson;
}
