export type MapLoadState = "loading" | "ready" | "failed";

/**
 * Radar-sweep loader laid over a map until its picture is on screen. Once the map is ready it
 * fades out (and leaves the accessibility tree); if the map fails it keeps a short message.
 */
export default function MapLoader({ state, label, failedLabel }: { state: MapLoadState; label: string; failedLabel: string }) {
  return (
    <div className="map-loader" data-state={state} role="status" aria-live="polite">
      {state !== "failed" && <span className="map-loader-radar" aria-hidden="true" />}
      <span className="map-loader-label">{state === "failed" ? failedLabel : label}</span>
    </div>
  );
}
