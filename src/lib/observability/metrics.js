import crypto from "node:crypto";

const MAX_SERIES = 256;
const MAX_SAMPLES = 256;
const SAFE_LABEL = /^[a-z0-9_][a-z0-9_.-]{0,31}$/;
const ALLOWED_LABELS = new Set([
  "provider", "route", "status", "outcome", "reason", "state", "from", "to", "kind",
]);

function createState() {
  return {
    startedAt: Date.now(),
    counters: new Map(),
    gauges: new Map(),
    histograms: new Map(),
  };
}

if (!globalThis.__rcRouterObservability) globalThis.__rcRouterObservability = createState();
const state = globalThis.__rcRouterObservability;

function normalizeMetricName(name) {
  const value = String(name || "unknown").toLowerCase().replace(/[^a-z0-9_.-]/g, "_").slice(0, 64);
  return value || "unknown";
}

function normalizeLabelValue(value) {
  const normalized = String(value ?? "unknown").toLowerCase().replace(/[^a-z0-9_.-]/g, "_").slice(0, 32);
  return SAFE_LABEL.test(normalized) ? normalized : "unknown";
}

function normalizeLabels(labels = {}) {
  const result = {};
  for (const [key, value] of Object.entries(labels || {})) {
    if (!ALLOWED_LABELS.has(key)) continue;
    result[key] = normalizeLabelValue(value);
  }
  return result;
}

function seriesKey(labels) {
  return Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`).join(",") || "_total";
}

function getMetricSeries(store, name) {
  let metric = store.get(name);
  if (!metric) {
    metric = new Map();
    store.set(name, metric);
  }
  return metric;
}

function boundedSeries(metric, key) {
  if (metric.has(key)) return metric.get(key);
  if (metric.size >= MAX_SERIES) {
    const overflow = metric.get("_overflow");
    if (overflow) return overflow;
    metric.set("_overflow", { value: 0, labels: { outcome: "overflow" } });
    return metric.get("_overflow");
  }
  const entry = { value: 0, labels: {} };
  metric.set(key, entry);
  return entry;
}

export function recordMetric(name, value = 1, labels = {}) {
  const metricName = normalizeMetricName(name);
  const safeLabels = normalizeLabels(labels);
  const metric = getMetricSeries(state.counters, metricName);
  const key = seriesKey(safeLabels);
  const entry = boundedSeries(metric, key);
  entry.labels = safeLabels;
  entry.value += Number.isFinite(Number(value)) ? Number(value) : 0;
}

export function incrementMetric(name, labels = {}) {
  recordMetric(name, 1, labels);
}

export function setMetricGauge(name, value, labels = {}) {
  const metricName = normalizeMetricName(name);
  const safeLabels = normalizeLabels(labels);
  const metric = getMetricSeries(state.gauges, metricName);
  const key = seriesKey(safeLabels);
  const entry = boundedSeries(metric, key);
  entry.labels = safeLabels;
  entry.value = Number.isFinite(Number(value)) ? Number(value) : 0;
}

export function observeMetric(name, value, labels = {}) {
  const metricName = normalizeMetricName(name);
  const safeLabels = normalizeLabels(labels);
  const metric = getMetricSeries(state.histograms, metricName);
  const key = seriesKey(safeLabels);
  const entry = boundedSeries(metric, key);
  entry.labels = safeLabels;
  const sample = Number(value);
  if (!Number.isFinite(sample)) return;
  if (!entry.samples) entry.samples = [];
  entry.samples.push(sample);
  if (entry.samples.length > MAX_SAMPLES) entry.samples.shift();
}

function serializeStore(store, histogram = false) {
  const result = {};
  for (const [name, metric] of store) {
    result[name] = {};
    for (const [key, entry] of metric) {
      const payload = { value: histogram ? undefined : entry.value, labels: entry.labels };
      if (histogram) {
        const samples = entry.samples || [];
        const sorted = [...samples].sort((a, b) => a - b);
        payload.count = samples.length;
        payload.min = sorted[0] ?? 0;
        payload.max = sorted.at(-1) ?? 0;
        payload.avg = samples.length ? samples.reduce((sum, item) => sum + item, 0) / samples.length : 0;
        payload.p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : 0;
        delete payload.value;
      }
      if (!histogram && payload.value === undefined) delete payload.value;
      result[name][key] = payload;
    }
  }
  return result;
}

export function getMetricsSnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    startedAt: new Date(state.startedAt).toISOString(),
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000)),
    counters: serializeStore(state.counters),
    gauges: serializeStore(state.gauges),
    histograms: serializeStore(state.histograms, true),
  };
}

export function createCorrelationId() {
  return `rc_${crypto.randomBytes(12).toString("base64url")}`;
}

export function addCorrelationHeader(response, correlationId = createCorrelationId()) {
  if (!response || !response.headers) return response;
  const headers = new Headers(response.headers);
  headers.set("x-rc-correlation-id", correlationId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function opaqueIdentifier(value, namespace = "id") {
  const digest = crypto.createHash("sha256").update(`${namespace}:${String(value || "")}`).digest("hex");
  return `${namespace}_${digest.slice(0, 12)}`;
}

// Test-only reset: production code never calls this, and the state remains bounded.
export function __resetMetricsForTests() {
  globalThis.__rcRouterObservability = createState();
  Object.assign(state, globalThis.__rcRouterObservability);
}
