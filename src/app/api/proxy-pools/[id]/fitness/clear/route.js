import { NextResponse } from "next/server";
import { clearPoolUnfit } from "open-sse/services/proxyPoolFitness.js";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

// POST /api/proxy-pools/[id]/fitness/clear - Clear one scope ({ scope }) of one pool.
export async function POST(request, { params }) {
  // Defence in depth: dashboardGuard.js already denies this path by default.
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const scope = typeof body?.scope === "string" ? body.scope.trim() : "";
    if (!id || !scope) {
      return NextResponse.json({ error: "pool id and scope are required" }, { status: 400 });
    }

    const cleared = await clearPoolUnfit(id, scope);
    if (!cleared) {
      return NextResponse.json({ error: "Failed to clear proxy fitness" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, poolId: id, scope });
  } catch (error) {
    console.log("Error clearing pool fitness:", error);
    return NextResponse.json({ error: "Failed to clear pool fitness" }, { status: 500 });
  }
}
