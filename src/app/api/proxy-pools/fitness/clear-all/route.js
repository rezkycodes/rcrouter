import { NextResponse } from "next/server";
import { clearAllPoolUnfit } from "open-sse/services/proxyPoolFitness.js";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

// POST /api/proxy-pools/fitness/clear-all - Clear every block, or only one
// provider's when the body carries { provider }.
export async function POST(request) {
  // Defence in depth: dashboardGuard.js already denies this path by default.
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const provider = typeof body?.provider === "string" && body.provider.trim() ? body.provider.trim() : null;

    const cleared = await clearAllPoolUnfit(provider);
    if (!cleared) {
      return NextResponse.json({ error: "Failed to clear proxy fitness" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, provider });
  } catch (error) {
    console.log("Error clearing proxy fitness:", error);
    return NextResponse.json({ error: "Failed to clear proxy fitness" }, { status: 500 });
  }
}
