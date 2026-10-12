import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { cameraPointing } from "@/lib/orientation";
import { parseNumericDraft } from "@/lib/number-input";
import { numberParam, optionalNumberParam } from "@/lib/api-params";
import { TtlCache } from "@/lib/bounded-cache";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { isAlertPrefs, isLensList, isLocationList, isSavedLocation, isSearchRange } from "@/lib/persisted-validators";
import { fetchJsonWithRetry } from "@/lib/providers/fetch";

describe("camera pointing from device orientation", () => {
  it("points the rear camera at the horizon when the phone is upright", () => {
    const pointing = cameraPointing(0, 90, 0);
    expect(pointing.elevationDeg).toBeCloseTo(0, 6);
    expect(pointing.headingDeg).toBeCloseTo(0, 6);
  });
  it("reports a positive elevation when the top of the phone tilts back", () => {
    expect(cameraPointing(0, 110, 0).elevationDeg).toBeCloseTo(20, 6);
  });
  it("reports a negative elevation when the camera tilts toward the ground", () => {
    expect(cameraPointing(0, 70, 0).elevationDeg).toBeCloseTo(-20, 6);
    expect(cameraPointing(0, 0, 0).elevationDeg).toBeCloseTo(-90, 6);
  });
  it("converts counter-clockwise alpha into a clockwise compass heading", () => {
    expect(cameraPointing(90, 90, 0).headingDeg).toBeCloseTo(270, 6);
    expect(cameraPointing(270, 90, 0).headingDeg).toBeCloseTo(90, 6);
  });
  it("keeps the horizon at zero elevation in landscape orientation", () => {
    expect(cameraPointing(0, 0, 90).elevationDeg).toBeCloseTo(0, 6);
    expect(cameraPointing(0, 0, -90).elevationDeg).toBeCloseTo(0, 6);
  });
});

describe("numeric draft parsing", () => {
  it("parses dot and Greek comma decimals", () => {
    expect(parseNumericDraft("38.2466")).toBe(38.2466);
    expect(parseNumericDraft("38,5")).toBe(38.5);
    expect(parseNumericDraft(" 22.43 ")).toBe(22.43);
  });
  it("treats an unfinished decimal as its integer value", () => {
    expect(parseNumericDraft("38.")).toBe(38);
  });
  it("rejects empty or incomplete input instead of returning zero", () => {
    expect(parseNumericDraft("")).toBeNull();
    expect(parseNumericDraft("-")).toBeNull();
    expect(parseNumericDraft("abc")).toBeNull();
  });
  it("rejects values outside the allowed range", () => {
    expect(parseNumericDraft("2466", -90, 90)).toBeNull();
    expect(parseNumericDraft("-90", -90, 90)).toBe(-90);
  });
});

describe("API query parameters", () => {
  const schema = z.object({ lat: numberParam(-90, 90), elevation: optionalNumberParam(-500, 9000, 210) });
  it("rejects an empty coordinate instead of coercing it to zero", () => {
    expect(schema.safeParse({ lat: "", elevation: "10" }).success).toBe(false);
    expect(schema.safeParse({ elevation: "10" }).success).toBe(false);
  });
  it("accepts numeric strings and applies defaults to empty optional values", () => {
    expect(schema.parse({ lat: "37.1", elevation: "" })).toEqual({ lat: 37.1, elevation: 210 });
  });
  it("rejects out-of-range values", () => {
    expect(schema.safeParse({ lat: "2466" }).success).toBe(false);
  });
});

describe("bounded TTL cache", () => {
  it("evicts the oldest entry beyond the size limit", () => {
    const cache = new TtlCache<number>(2);
    cache.set("a", 1, 1_000, 0);
    cache.set("b", 2, 1_000, 0);
    cache.set("c", 3, 1_000, 0);
    expect(cache.get("a", 1)).toBeUndefined();
    expect(cache.get("b", 1)).toBe(2);
    expect(cache.get("c", 1)).toBe(3);
  });
  it("does not return expired entries", () => {
    const cache = new TtlCache<number>(5);
    cache.set("a", 1, 100, 0);
    expect(cache.get("a", 99)).toBe(1);
    expect(cache.get("a", 101)).toBeUndefined();
  });
});

describe("rate limiting", () => {
  it("blocks a client after the limit and resets after the window", () => {
    const allow = createRateLimiter({ limit: 2, windowMs: 1_000 });
    expect(allow("ip", 0)).toBe(true);
    expect(allow("ip", 10)).toBe(true);
    expect(allow("ip", 20)).toBe(false);
    expect(allow("other", 20)).toBe(true);
    expect(allow("ip", 1_001)).toBe(true);
  });
  it("identifies clients by the edge-provided address", () => {
    expect(clientKey(new Request("https://x", { headers: { "cf-connecting-ip": "1.2.3.4" } }))).toBe("1.2.3.4");
    expect(clientKey(new Request("https://x", { headers: { "x-forwarded-for": "5.6.7.8, 9.9.9.9" } }))).toBe("5.6.7.8");
    expect(clientKey(new Request("https://x"))).toBe("anonymous");
  });
});

describe("persisted state validation", () => {
  const location = { id: "x", name: "X", latitude: 37, longitude: 22, elevationM: 100, cameraHeightM: 1.6, favorite: false, lightPollution: "low", notes: "", safetyNotes: "" };
  it("rejects stored observers with impossible coordinates", () => {
    expect(isSavedLocation(location)).toBe(true);
    expect(isSavedLocation({ ...location, latitude: 2466 })).toBe(false);
    expect(isSavedLocation({ ...location, longitude: "22" })).toBe(false);
    expect(isSavedLocation(null)).toBe(false);
  });
  it("rejects a saved-location list containing an invalid entry", () => {
    expect(isLocationList([location])).toBe(true);
    expect(isLocationList([location, { ...location, latitude: 2466 }])).toBe(false);
    expect(isLocationList([])).toBe(false);
  });
  it("rejects inverted or out-of-range search rings", () => {
    expect(isSearchRange({ min: 200, max: 600 })).toBe(true);
    expect(isSearchRange({ min: 600, max: 200 })).toBe(false);
    expect(isSearchRange({ min: 50, max: 600 })).toBe(false);
  });
  it("rejects alert preferences with an unusable threshold or quiet window", () => {
    const prefs = { minimumScore: 60, confidence: "medium", cooldown: 90, quietStart: "01:00", quietEnd: "08:00" };
    expect(isAlertPrefs(prefs)).toBe(true);
    expect(isAlertPrefs({ ...prefs, minimumScore: 150 })).toBe(false);
    expect(isAlertPrefs({ ...prefs, confidence: "certain" })).toBe(false);
    expect(isAlertPrefs({ ...prefs, quietStart: "25:00" })).toBe(false);
  });
  it("rejects an empty or malformed lens list", () => {
    expect(isLensList([{ id: "l", name: "L", focalLengthMm: 24, maxAperture: 2.8, mount: "EF", owned: true }])).toBe(true);
    expect(isLensList([])).toBe(false);
    expect(isLensList([{ id: "l", name: "L", focalLengthMm: 0, maxAperture: 2.8 }])).toBe(false);
  });
});

describe("provider fetch retries", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("does not retry client errors", async () => {
    const fetchMock = vi.fn(async () => new Response("bad", { status: 400, statusText: "Bad Request" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchJsonWithRetry("https://example.test", { retries: 2, timeoutMs: 1_000 })).rejects.toThrow("HTTP 400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries rate limits and server errors", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchJsonWithRetry("https://example.test", { retries: 2, timeoutMs: 1_000 })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops retrying when the total deadline is spent", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetchMock);
    const started = Date.now();
    await expect(fetchJsonWithRetry("https://example.test", { retries: 5, timeoutMs: 5_000, deadlineMs: 120 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
