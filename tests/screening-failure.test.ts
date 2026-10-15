import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpportunities } from "@/lib/providers/open-meteo";

const hours = Array.from({ length: 48 }, (_, index) => new Date(Date.UTC(2026, 9, 14, index)).toISOString().slice(0, 16));
const forecast = (latitude: number, longitude: number) => ({ latitude, longitude, elevation: 0, hourly: { time: hours, cloud_cover: hours.map(() => 10) } });

// Open-Meteo stand-in: the observer request answers, the multi-cell scan requests get the
// given status. Every other provider fails, as the browser fallback would see them.
function stubOpenMeteo(scanStatus: () => number) {
  const scanCalls: number[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = new URL(input.toString());
    if (url.hostname !== "api.open-meteo.com") return new Response("unavailable", { status: 503 });
    const latitudes = url.searchParams.get("latitude")!.split(",").map(Number);
    const longitudes = url.searchParams.get("longitude")!.split(",").map(Number);
    if (latitudes.length === 1) return Response.json(forecast(latitudes[0], longitudes[0]));
    const status = scanStatus();
    scanCalls.push(status);
    if (status !== 200) return new Response("Minutely API request limit exceeded", { status, statusText: "Too Many Requests" });
    return Response.json(latitudes.map((latitude, index) => forecast(latitude, longitudes[index])));
  }));
  return scanCalls;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("failed scan cells", () => {
  it("names the cause and asks again after two minutes instead of fifteen", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 14, 1));
    let status = 429;
    const scanCalls = stubOpenMeteo(() => status);
    const observer = { latitude: 37.2, longitude: 22.1 };

    const failed = await fetchOpportunities(observer, 200, 600, { serverOnlySources: false });
    const message = failed.providers.find((provider) => provider.id === "open_meteo")!.message.en;
    // 200–600 km: four rings, every 15°.
    expect(message).toContain("0/96 scan cells answered");
    expect(message).toContain("HTTP 429");

    status = 200;
    const callsBefore = scanCalls.length;
    vi.setSystemTime(Date.UTC(2026, 9, 14, 1, 1));
    await fetchOpportunities(observer, 200, 600, { serverOnlySources: false });
    expect(scanCalls.length).toBe(callsBefore);

    vi.setSystemTime(Date.UTC(2026, 9, 14, 1, 3));
    const recovered = await fetchOpportunities(observer, 200, 600, { serverOnlySources: false });
    expect(recovered.providers.find((provider) => provider.id === "open_meteo")!.message.en).toContain("96 scan cells available");
  });
});
