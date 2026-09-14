import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exportDb: vi.fn(),
  importDb: vi.fn(),
  getSettings: vi.fn(),
  applyOutboundProxyEnv: vi.fn(),
  verifyDashboardPassword: vi.fn(),
  getConsistentMachineId: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => ({ body, status: init.status || 200 }),
  },
}));

vi.mock("@/lib/localDb", () => ({
  exportDb: mocks.exportDb,
  importDb: mocks.importDb,
  getSettings: mocks.getSettings,
}));

vi.mock("@/lib/network/outboundProxy", () => ({
  applyOutboundProxyEnv: mocks.applyOutboundProxyEnv,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardPassword: mocks.verifyDashboardPassword,
}));

vi.mock("@/shared/utils/machineId.js", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

const { GET, POST } = await import("../../src/app/api/settings/database/route.js");

function request({ headers = {}, body } = {}) {
  return {
    headers: new Headers(headers),
    json: async () => body,
  };
}

describe("database route CLI authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConsistentMachineId.mockResolvedValue("valid-cli-token");
    mocks.verifyDashboardPassword.mockResolvedValue(false);
    mocks.exportDb.mockResolvedValue({ providerConnections: [] });
    mocks.importDb.mockResolvedValue(undefined);
    mocks.getSettings.mockResolvedValue({});
  });

  it("rejects a forged non-empty CLI token instead of bypassing password auth", async () => {
    const response = await GET(request({ headers: { "x-rc-cli-token": "forged-token" } }));

    expect(response.status).toBe(401);
    expect(mocks.exportDb).not.toHaveBeenCalled();
  });

  it("accepts a machine-bound CLI token for export", async () => {
    const response = await GET(request({ headers: { "x-rc-cli-token": "valid-cli-token" } }));

    expect(response.status).toBe(200);
    expect(mocks.exportDb).toHaveBeenCalledOnce();
    expect(mocks.verifyDashboardPassword).not.toHaveBeenCalled();
  });

  it("falls back to password authentication for import", async () => {
    mocks.verifyDashboardPassword.mockResolvedValue(true);
    const response = await POST(request({ body: { password: "correct", settings: {} } }));

    expect(response.status).toBe(200);
    expect(mocks.importDb).toHaveBeenCalledWith({ settings: {} });
    expect(mocks.applyOutboundProxyEnv).toHaveBeenCalledWith({});
  });
});
