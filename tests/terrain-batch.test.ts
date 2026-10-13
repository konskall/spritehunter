import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTerrainProfiles } from "@/lib/providers/terrain";

// OpenTopoData stand-in: flat ground at 100 m, one result per requested location.
function stubDem() {
  const calls: number[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const locations = new URL(input.toString()).searchParams.get("locations")!.split("|");
    calls.push(locations.length);
    const results = locations.map((location) => {
      const [lat, lng] = location.split(",").map(Number);
      return { elevation: 100, location: { lat, lng } };
    });
    return new Response(JSON.stringify({ status: "OK", results }), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("terrain profiles for all targets", () => {
  it("checks every bearing, five per DEM request, and reuses the cache", async () => {
    const calls = stubDem();
    const observer = { latitude: 37.1, longitude: 22.4 };
    const bearings = [101.9, 121.3, 140, 150, 160, 170, 180.4];
    const profiles = await fetchTerrainProfiles(observer, bearings, 1.6);
    expect(calls).toEqual([100, 40]);
    expect(profiles.map((profile) => profile.bearingDeg)).toEqual([102, 121, 140, 150, 160, 170, 180]);
    expect(profiles.every((profile) => profile.status === "available" && profile.samples.length === 20)).toBe(true);

    const again = await fetchTerrainProfiles(observer, [121.4, 102.2], 1.6);
    expect(calls).toEqual([100, 40]);
    expect(again.map((profile) => profile.bearingDeg)).toEqual([121, 102]);
  });

  it("marks bearings unverified when the DEM fails, without caching the failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 400 })));
    const observer = { latitude: 36.5, longitude: 23 };
    const [profile] = await fetchTerrainProfiles(observer, [45], 1.6);
    expect(profile.status).toBe("unavailable");
    expect(profile.horizonAngleDeg).toBeNull();

    const calls = stubDem();
    const [retried] = await fetchTerrainProfiles(observer, [45], 1.6);
    expect(calls).toEqual([20]);
    expect(retried.status).toBe("available");
  });
});
