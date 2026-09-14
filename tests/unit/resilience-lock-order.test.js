import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("routing resilience lock order", () => {
  it("keeps breaker checks before credential selection and semaphore acquisition", () => {
    const source = fs.readFileSync(path.resolve("src/sse/handlers/chat.js"), "utf8");
    const loop = source.slice(source.indexOf("async function handleSingleModelChat"));
    const breaker = loop.indexOf("checkCircuitBreaker(provider");
    const credentials = loop.indexOf("getProviderCredentials(provider");
    const semaphore = loop.indexOf("acquireAccountSlot(");

    expect(breaker).toBeGreaterThanOrEqual(0);
    expect(credentials).toBeGreaterThan(breaker);
    expect(semaphore).toBeGreaterThan(credentials);
    expect(loop).toContain("releaseAccountSlot?.();");
  });

  it("releases the account semaphore in a finally block before fallback state updates", () => {
    const source = fs.readFileSync(path.resolve("src/sse/handlers/chat.js"), "utf8");
    const release = source.indexOf("releaseAccountSlot?.();");
    const markUnavailable = source.indexOf("markAccountUnavailable(");
    expect(release).toBeGreaterThanOrEqual(0);
    expect(markUnavailable).toBeGreaterThan(release);
    expect(source.slice(Math.max(0, release - 180), release)).toContain("finally");
  });
});
