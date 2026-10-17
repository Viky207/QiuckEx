import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendUniqueActivityItems,
  fetchActivityFeed,
  type ActivityFeedItem,
} from "@/hooks/activityFeedApi";

vi.mock("@/lib/api", () => ({
  getQuickexApiBase: () => "https://api.quickex.to",
}));

vi.mock("@/lib/publicKey", () => ({
  resolvePublicKey: () => `G${"A".repeat(55)}`,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchActivityFeed", () => {
  it("requests the next cursor page and exposes its continuation cursor", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            amount: "2.5",
            asset: "XLM",
            memo: null,
            timestamp: "2026-10-17T12:00:00.000Z",
            source: `G${"B".repeat(55)}`,
            destination: `G${"A".repeat(55)}`,
            status: "Success",
            txHash: "tx-one",
            pagingToken: "100",
          },
        ],
        nextCursor: "200",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchActivityFeed(20, "100");
    const requestedUrl = new URL(fetchMock.mock.calls[0][0]);

    expect(requestedUrl.searchParams.get("cursor")).toBe("100");
    expect(requestedUrl.searchParams.get("limit")).toBe("20");
    expect(result.items[0].id).toBe("tx-one");
    expect(result.nextCursor).toBe("200");
    expect(result.degraded).toBe(false);
  });

  it("returns a retryable degraded result when the API is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    await expect(fetchActivityFeed(20, "100")).resolves.toMatchObject({
      items: [],
      degraded: true,
      error: "Recent payments are temporarily unavailable.",
    });
  });
});

describe("appendUniqueActivityItems", () => {
  it("does not duplicate transactions when a page is replayed", () => {
    const existing = [{ id: "tx-one" }] as ActivityFeedItem[];
    const incoming = [
      { id: "tx-one" },
      { id: "tx-two" },
      { id: "tx-two" },
    ] as ActivityFeedItem[];

    expect(appendUniqueActivityItems(existing, incoming).map((item) => item.id)).toEqual([
      "tx-one",
      "tx-two",
    ]);
  });
});