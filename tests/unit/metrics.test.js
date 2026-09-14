import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetMetricsForTests,
  addCorrelationHeader,
  getMetricsSnapshot,
  incrementMetric,
  observeMetric,
  opaqueIdentifier,
  setMetricGauge,
} from "../../src/lib/observability/metrics.js";

describe("privacy-safe operational metrics", () => {
  beforeEach(() => __resetMetricsForTests());

  it("keeps only bounded, allow-listed labels", () => {
    incrementMetric("router_requests_total", {
      provider: "OpenAI",
      route: "chat",
      apiKey: "secret-key",
    });

    const snapshot = getMetricsSnapshot();
    const series = Object.values(snapshot.counters.router_requests_total);
    expect(series).toHaveLength(1);
    expect(series[0].labels).toEqual({ provider: "openai", route: "chat" });
    expect(JSON.stringify(snapshot)).not.toContain("secret-key");
  });

  it("reports gauges and bounded histogram summaries", () => {
    setMetricGauge("router_active_requests", 3, { state: "running" });
    observeMetric("router_latency_ms", 10, { kind: "request" });
    observeMetric("router_latency_ms", 20, { kind: "request" });
    observeMetric("router_latency_ms", 30, { kind: "request" });

    const snapshot = getMetricsSnapshot();
    expect(Object.values(snapshot.gauges.router_active_requests)[0]).toMatchObject({
      value: 3,
      labels: { state: "running" },
    });
    expect(Object.values(snapshot.histograms.router_latency_ms)[0]).toMatchObject({
      count: 3,
      min: 10,
      max: 30,
      avg: 20,
      p95: 30,
      labels: { kind: "request" },
    });
  });

  it("adds a correlation header without exposing the source identifier", async () => {
    const response = addCorrelationHeader(
      new Response("ok", { status: 201, headers: { "x-test": "yes" } }),
      "rc_fixed-id"
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("x-test")).toBe("yes");
    expect(response.headers.get("x-rc-correlation-id")).toBe("rc_fixed-id");
    expect(await response.text()).toBe("ok");
  });

  it("uses deterministic opaque identifiers", () => {
    const first = opaqueIdentifier("account-secret", "semaphore");
    expect(first).toMatch(/^semaphore_[a-f0-9]{12}$/);
    expect(first).toBe(opaqueIdentifier("account-secret", "semaphore"));
    expect(first).not.toContain("account-secret");
  });
});
