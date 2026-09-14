import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAdapter: vi.fn() }));

vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: mocks.getAdapter }));

const { getProviderConnections, getProviderConnectionById, invalidateConnectionCache } =
  await import("../../src/lib/db/repos/connectionsRepo.js");

const row = (id = "conn-1") => ({
  id,
  provider: "openai",
  authType: "apikey",
  name: "primary",
  email: null,
  priority: 1,
  isActive: 1,
  data: JSON.stringify({ defaultModel: "gpt-4o" }),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

beforeEach(() => {
  invalidateConnectionCache();
  vi.clearAllMocks();
});

describe("provider connection cache", () => {
  it("reuses a fresh list result while returning defensive copies", async () => {
    const db = { all: vi.fn(() => [row()]) };
    mocks.getAdapter.mockResolvedValue(db);

    const first = await getProviderConnections({ provider: "openai", isActive: true });
    first[0].name = "mutated-by-caller";
    const second = await getProviderConnections({ provider: "openai", isActive: true });

    expect(db.all).toHaveBeenCalledTimes(1);
    expect(second[0].name).toBe("primary");
    expect(second).not.toBe(first);
  });

  it("invalidates list and id entries after a connection mutation", async () => {
    const db = {
      all: vi.fn(() => [row()]),
      get: vi.fn(() => row()),
    };
    mocks.getAdapter.mockResolvedValue(db);

    await getProviderConnections({ provider: "openai", isActive: true });
    await getProviderConnectionById("conn-1");
    expect(db.all).toHaveBeenCalledTimes(1);
    expect(db.get).toHaveBeenCalledTimes(1);

    invalidateConnectionCache();
    await getProviderConnections({ provider: "openai", isActive: true });
    await getProviderConnectionById("conn-1");

    expect(db.all).toHaveBeenCalledTimes(2);
    expect(db.get).toHaveBeenCalledTimes(2);
  });
});
