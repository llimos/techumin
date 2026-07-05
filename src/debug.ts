/**
 * Debug mode, enabled with a `?debug` query string: numbers the detected
 * cities on the map and logs merge decisions to the console.
 */

const debugParam = new URLSearchParams(location.search).get('debug');
export const DEBUG = debugParam !== null && debugParam !== '0' && debugParam !== 'false';

export function debugLog(message: string): void {
  if (DEBUG) console.log(`[techum debug] ${message}`);
}
