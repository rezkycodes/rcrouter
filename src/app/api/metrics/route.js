import { NextResponse } from "next/server";
import { requireDashboardAuth } from "@/lib/auth/routeAuth.js";
import {
  addCorrelationHeader,
  createCorrelationId,
  getMetricsSnapshot,
  opaqueIdentifier,
} from "@/lib/observability/metrics.js";
import { getAllCircuitBreakerStatuses } from "open-sse/utils/circuitBreaker.js";
import { getAccountSemaphoreStats } from "open-sse/services/accountSemaphore.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/metrics
 * Dashboard-only operational snapshot. It intentionally excludes prompts,
 * credentials, raw session ids, and raw semaphore keys.
 */
export async function GET(request) {
  const correlationId = createCorrelationId();
  if (!(await requireDashboardAuth(request))) {
    return addCorrelationHeader(NextResponse.json({ error: "Unauthorized" }, { status: 401 }), correlationId);
  }

  const semaphores = getAccountSemaphoreStats().map(({ key, ...entry }) => ({
    ...entry,
    key: opaqueIdentifier(key, "semaphore"),
  }));
  const payload = {
    correlationId,
    metrics: getMetricsSnapshot(),
    circuitBreakers: getAllCircuitBreakerStatuses(),
    accountSemaphores: semaphores,
  };
  return addCorrelationHeader(NextResponse.json(payload), correlationId);
}

