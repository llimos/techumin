/** Umami custom-event tracking. A no-op when the script is absent (blocked, dev). */
interface Umami {
  track(event: string, data?: Record<string, unknown>): void;
}

declare global {
  interface Window {
    umami?: Umami;
  }
}

export function track(event: string, data?: Record<string, unknown>): void {
  window.umami?.track(event, data);
}
