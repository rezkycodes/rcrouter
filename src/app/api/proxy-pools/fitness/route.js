import { NextResponse } from "next/server";
import { poolFitnessSnapshot } from "open-sse/services/proxyPoolFitness.js";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";

// GET /api/proxy-pools/fitness - Active "pool is unfit for provider::model" blocks,
// grouped as { pools: { [poolId]: { [scope]: { until, reason } } } }.
export async function GET(request) {
  // The /api guard in dashboardGuard.js already denies this path by default;
  // checking again keeps the route safe if that matcher ever changes.
  if (!(await requireDashboardAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json({ pools: await poolFitnessSnapshot() });
  } catch (error) {
    console.log("Error reading proxy fitness:", error);
    return NextResponse.json({ error: "Failed to read proxy fitness" }, { status: 500 });
  }
}
