import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { isAccountSemaphoreEnabled } from "../../open-sse/services/accountSemaphore.js";
import { mergeWithDefaults } from "../../src/lib/db/repos/settingsRepo.js";

// Dashboard "Guards & Shields" switches (Token Saver page). All three default on.
describe("guard settings", () => {
  describe("isAccountSemaphoreEnabled", () => {
    it("is on unless the setting is explicitly switched off", () => {
      expect(isAccountSemaphoreEnabled(undefined)).toBe(true);
      expect(isAccountSemaphoreEnabled(null)).toBe(true);
      expect(isAccountSemaphoreEnabled({})).toBe(true);
      expect(isAccountSemaphoreEnabled({ semaphoreEnabled: true })).toBe(true);
    });

    it("turns off for false and 0, matching the circuit breaker and loop guard checks", () => {
      expect(isAccountSemaphoreEnabled({ semaphoreEnabled: false })).toBe(false);
      expect(isAccountSemaphoreEnabled({ semaphoreEnabled: 0 })).toBe(false);
    });
  });

  describe("settings defaults", () => {
    it("ships all three guards enabled for new and existing installations", () => {
      const merged = mergeWithDefaults({});
      expect(merged.loopGuardEnabled).toBe(true);
      expect(merged.circuitBreakerEnabled).toBe(true);
      expect(merged.semaphoreEnabled).toBe(true);
    });

    it("keeps an operator's stored opt-out", () => {
      const merged = mergeWithDefaults({ semaphoreEnabled: false, circuitBreakerEnabled: false });
      expect(merged.semaphoreEnabled).toBe(false);
      expect(merged.circuitBreakerEnabled).toBe(false);
    });
  });

  describe("chat handler wiring", () => {
    it("derives the account semaphore key only while the semaphore guard is on", () => {
      const source = fs.readFileSync(path.resolve("src/sse/handlers/chat.js"), "utf8");

      // Guard on -> resolve the key; guard off -> null (which skips acquire, release and block marking).
      // Pinning the polarity so a flipped ternary cannot pass.
      expect(source).toMatch(
        /isAccountSemaphoreEnabled\(chatSettings\)\s*\?\s*resolveAccountSemaphoreKey\(\{[\s\S]*?\}\)\s*:\s*null/
      );
    });
  });
});
