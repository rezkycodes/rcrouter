// Pure view helpers behind the Proxy Fitness dashboard page.
import { describe, expect, it } from "vitest";
import {
  buildFitnessRecords,
  filterFitnessRecords,
  fitnessProviders,
  formatRemaining,
  parseFitnessScope,
} from "@/shared/utils/proxyFitness.js";

const NOW = 1_800_000_000_000;
const pools = [
  { id: "pool-aaaa-1111", name: "EU relay", proxyUrl: "http://user:secret@10.0.0.5:8080" },
  { id: "pool-bbbb-2222", name: "US relay", proxyUrl: "socks5://203.0.113.9:1080" },
];
const fitness = {
  "pool-aaaa-1111": {
    "freebuff::openai/gpt-5": { until: NOW + 60_000, reason: "limited_ip" },
    "opencode::*": { until: NOW + 120_000, reason: "" },
    "stale::m": { until: NOW - 1, reason: "expired" },
    "broken::m": { reason: "no until" },
  },
  "pool-bbbb-2222": { "freebuff::openai/gpt-5": { until: NOW + 30_000, reason: "limited_ip" } },
  "pool-gone-9999": { "freebuff::m": { until: NOW + 5_000, reason: "deleted pool" } },
};

describe("parseFitnessScope", () => {
  it("splits on the first separator only", () => {
    expect(parseFitnessScope("freebuff::openai/gpt-5")).toEqual({ provider: "freebuff", model: "openai/gpt-5", modelLabel: "openai/gpt-5" });
    expect(parseFitnessScope("p::a::b")).toEqual({ provider: "p", model: "a::b", modelLabel: "a::b" });
  });

  it("labels the provider wildcard as all models", () => {
    expect(parseFitnessScope("opencode::*")).toEqual({ provider: "opencode", model: "*", modelLabel: "all models" });
  });

  it("copes with a scope that has no separator", () => {
    expect(parseFitnessScope("lonely")).toEqual({ provider: "lonely", model: "", modelLabel: "all models" });
  });
});

describe("buildFitnessRecords", () => {
  const records = buildFitnessRecords(fitness, pools, NOW);

  it("keeps only active, well-formed blocks", () => {
    expect(records.map((r) => `${r.poolId}|${r.scope}`).sort()).toEqual([
      "pool-aaaa-1111|freebuff::openai/gpt-5",
      "pool-aaaa-1111|opencode::*",
      "pool-bbbb-2222|freebuff::openai/gpt-5",
      "pool-gone-9999|freebuff::m",
    ]);
  });

  it("resolves pool names and falls back to a short id for a deleted pool", () => {
    const byPool = Object.fromEntries(records.map((r) => [r.poolId, r.poolName]));
    expect(byPool["pool-aaaa-1111"]).toBe("EU relay");
    expect(byPool["pool-gone-9999"]).toBe("pool-gon");
  });

  it("never carries proxy credentials, only host:port", () => {
    const eu = records.find((r) => r.poolId === "pool-aaaa-1111");
    expect(eu.proxyHost).toBe("10.0.0.5:8080");
    expect(JSON.stringify(records)).not.toContain("secret");
  });

  it("defaults a blank reason and carries the expiry", () => {
    const wildcard = records.find((r) => r.scope === "opencode::*");
    expect(wildcard).toMatchObject({ reason: "blocked", until: NOW + 120_000, provider: "opencode", modelLabel: "all models" });
  });

  it("returns a stable order and does not mutate its inputs", () => {
    const snapshot = JSON.stringify([fitness, pools]);
    const again = buildFitnessRecords(fitness, pools, NOW);
    expect(again.map((r) => r.key)).toEqual(records.map((r) => r.key));
    expect(JSON.stringify([fitness, pools])).toBe(snapshot);
  });

  it("handles empty or missing input", () => {
    expect(buildFitnessRecords(undefined, undefined, NOW)).toEqual([]);
    expect(buildFitnessRecords({}, [], NOW)).toEqual([]);
    expect(buildFitnessRecords({ p: null }, null, NOW)).toEqual([]);
  });
});

describe("filtering", () => {
  const records = buildFitnessRecords(fitness, pools, NOW);

  it("lists providers once, sorted", () => {
    expect(fitnessProviders(records)).toEqual(["freebuff", "opencode"]);
  });

  it("filters by provider", () => {
    expect(filterFitnessRecords(records, { provider: "opencode", search: "" })).toHaveLength(1);
    expect(filterFitnessRecords(records, { provider: "all", search: "" })).toHaveLength(4);
  });

  it("searches pool name, proxy host, model and reason, case-insensitively", () => {
    const ids = (search) => filterFitnessRecords(records, { provider: "all", search }).map((r) => r.poolId);
    expect(ids("eu relay")).toEqual(["pool-aaaa-1111", "pool-aaaa-1111"]);
    expect(ids("203.0.113")).toEqual(["pool-bbbb-2222"]);
    expect(ids("GPT-5")).toHaveLength(2);
    expect(ids("deleted pool")).toEqual(["pool-gone-9999"]);
  });
});

describe("formatRemaining", () => {
  it.each([
    [NOW - 1, "expired"],
    [NOW + 30_000, "30s"],
    [NOW + 4 * 60_000 + 20_000, "4m"],
    [NOW + 65 * 60_000, "1h 5m"],
    [NOW + 3 * 3_600_000, "3h"],
  ])("formats %i as %s", (until, text) => {
    expect(formatRemaining(until, NOW)).toBe(text);
  });
});
