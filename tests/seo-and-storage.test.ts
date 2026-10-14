import { describe, expect, it } from "vitest";
import { pageMetadata, structuredDataJson } from "@/lib/seo";
import { SEO_COPY } from "@/lib/seo-copy";
import sitemap from "@/app/sitemap";
import { GET as llmsTxt } from "@/app/llms.txt/route";
import { isLogEntry } from "@/lib/persisted-validators";
import { DEFAULT_LENSES, photoRecommendation } from "@/lib/camera";

describe("search metadata per language", () => {
  it("gives each language its own title, canonical address and hreflang links", () => {
    const greek = pageMetadata("el");
    const english = pageMetadata("en");
    expect(greek.title).toBe(SEO_COPY.el.title);
    expect(english.title).toBe(SEO_COPY.en.title);
    expect(english.description).toBe(SEO_COPY.en.description);
    expect(greek.alternates?.canonical).toBe("/");
    expect(english.alternates?.canonical).toBe("/en");
    expect(english.alternates?.languages).toEqual({ el: "/", en: "/en", "x-default": "/" });
    expect(english.openGraph).toMatchObject({ locale: "en_GB", alternateLocale: "el_GR", url: "/en" });
  });

  it("describes the app in the page language and cannot close its script tag", () => {
    const data = JSON.parse(structuredDataJson("en"));
    expect(data.inLanguage).toBe("en");
    expect(data.url.endsWith("/en")).toBe(true);
    expect(structuredDataJson("el")).not.toContain("<");
  });

  it("lists both languages in the sitemap with their alternates", () => {
    const entries = sitemap();
    expect(entries.map((entry) => new URL(entry.url).pathname)).toEqual(["/", "/en"]);
    expect(Object.keys(entries[1].alternates?.languages ?? {})).toEqual(["el", "en"]);
  });

  it("serves llms.txt as plain text that links both language versions", async () => {
    const response = llmsTxt();
    expect(response.headers.get("content-type")).toContain("text/plain");
    const text = await response.text();
    expect(text.startsWith("# SpriteHunter")).toBe(true);
    expect(text).toMatch(/\]\(https?:\/\/[^)]+\/en\)/);
  });
});

describe("stored logbook entries", () => {
  const entry = { id: "1", timestamp: "2026-10-14T00:00:00Z", target: "121° / 453 km", tleType: "Red Sprite", lens: "Tokina", iso: 3200, aperture: 2.8, shutter: "3 s", success: "yes", notes: "" };
  it("accepts a complete entry and rejects broken ones", () => {
    expect(isLogEntry(entry)).toBe(true);
    expect(isLogEntry({ ...entry, iso: "3200" })).toBe(false);
    expect(isLogEntry({ ...entry, success: "maybe" })).toBe(false);
    expect(isLogEntry(null)).toBe(false);
  });
});

describe("lens advice", () => {
  const wide = DEFAULT_LENSES[0];
  it("warns about a narrow frame only when the target does not fit", () => {
    const fits = photoRecommendation(wide, false, true, "en");
    const tooNarrow = photoRecommendation(wide, false, false, "en");
    expect(fits.warning).not.toMatch(/narrow/);
    expect(tooNarrow.warning).toMatch(/narrow/);
  });
});
