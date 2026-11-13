const STORAGE_KEY = "mmtai-heatmap";
const listeners = new Set<() => void>();

/**
 * Read this browser's heatmap preference.
 *
 * Kept outside React so the preference can be read through `useSyncExternalStore`:
 * that gives a server snapshot of "off" and a client snapshot of the stored value
 * without calling setState from an effect, which React's lint rules reject.
 */
export function getHeatmapPreference(): boolean {
  return window.localStorage.getItem(STORAGE_KEY) === "on";
}

/** Server and first-hydration snapshot: the overlay starts off. */
export function getServerHeatmapPreference(): boolean {
  return false;
}

/**
 * Store the preference and notify every subscribed component.
 *
 * The `storage` event only fires in other tabs, so local listeners are called
 * directly to keep this tab's toggle in sync.
 */
export function setHeatmapPreference(value: boolean): void {
  window.localStorage.setItem(STORAGE_KEY, value ? "on" : "off");
  for (const listener of listeners) listener();
}

/** Subscribe to preference changes from a toggle or another tab. */
export function subscribeHeatmapPreference(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}
