import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireDashboardAuth: vi.fn(),
  getAllCircuitBreakerStatuses: vi.fn(),
  getAccountSemaphoreStats: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => new Response(JSON.stringify(body), {
      status: init.status || 200,
      headers: { "content-type": "application/json" },
    }),
  },
}));
vi.mock("@/lib/auth/routeAuth.js", () => ({ requireDashboardAuth: mocks.requireDashboardAuth }));
vi.mock("open-sse/utils/circuitBreaker.js", () => ({
  getAllCircuitBreakerStatuses: mocks.getAllCircuitBreakerStatuses,
}));
vi.mock("open-sse/services/accountSemaphore.js", () => ({
  getAccountSemaphoreStats: mocks.getAccountSemaphoreStats,
}));

const { GET } = await import("../../src/app/api/metrics/route.js");

describe("GET /api/metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAllCircuitBreakerStatuses.mockReturnValue([{ name: "openai:proxy", state: "CLOSED" }]);
    mocks.getAccountSemaphoreStats.mockReturnValue([{ key: "openai:secret-connection:direct", running: 1, queued: 0 }]);
  });

  it("requires dashboard authorization", async () => {
    mocks.requireDashboardAuth.mockResolvedValue(false);
    const response = await GET(new Request("http://localhost/api/metrics"));
    expect(response.status).toBe(401);
    expect(response.headers.get("x-rc-correlation-id")).toMatch(/^rc_[A-Za-z0-9_-]{16}$/);
  });

  it("returns operational state with opaque semaphore identifiers", async () => {
    mocks.requireDashboardAuth.mockResolvedValue(true);
    const response = await GET(new Request("http://localhost/api/metrics"));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.correlationId).toBe(response.headers.get("x-rc-correlation-id"));
    expect(payload.accountSemaphores[0].key).toMatch(/^semaphore_[a-f0-9]{12}$/);
    expect(payload.accountSemaphores[0].key).not.toContain("secret-connection");
    expect(payload.metrics).toHaveProperty("counters");
  });
});

