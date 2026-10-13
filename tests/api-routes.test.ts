import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/providers/open-meteo", () => ({
  fetchOpportunities: vi.fn(async () => ({ candidates: [], providers: [], warnings: [] })),
}));

const { GET } = await import("@/app/api/opportunities/route");

describe("/api/opportunities", () => {
  it("is not cached by the browser, so «Ανανέωση δεδομένων» reaches the server", async () => {
    const response = await GET(new Request("http://localhost/api/opportunities?lat=38&lon=23.7"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
