import crypto from "node:crypto";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const CLI_TOKEN_HEADERS = ["x-rc-cli-token", "x-9r-cli-token"];
export const CLI_TOKEN_SALTS = ["rc-cli-auth", "9r-cli-auth"];

// getConsistentMachineId returns a 16-char lowercase hex string.
const EXPECTED_TOKEN_RE = /^[0-9a-f]{16}$/;

const _cachedTokens = {};

// Test-only: clear memoized tokens so different mocked machine IDs take effect.
export function __resetInternalTrustCacheForTests() {
  for (const k of Object.keys(_cachedTokens)) {
    delete _cachedTokens[k];
  }
}

async function getCachedTokenForSalt(salt) {
  if (_cachedTokens[salt] === undefined) {
    const computed = await getConsistentMachineId(salt);
    _cachedTokens[salt] = typeof computed === "string" ? computed : "";
  }
  return _cachedTokens[salt];
}

/**
 * Returns true ONLY when the request carries a valid internal CLI token, i.e.
 * it provably originates from the local dashboard/CLI rather than an external
 * API consumer. Trusted requests bypass the per-API-key ACL.
 *
 * @param {Request|{headers:{get(name:string):string|null}}} request
 * @returns {Promise<boolean>}
 */
export async function isTrustedInternalRequest(request) {
  try {
    const getter = request?.headers?.get;
    if (typeof getter !== "function") return false;

    // Check all supported CLI token headers
    for (const header of CLI_TOKEN_HEADERS) {
      const token = request.headers.get(header);
      if (typeof token !== "string" || token.length === 0) continue;

      // Check the salts, prioritizing the one matching the header prefix
      const salts = header.includes("rc")
        ? ["rc-cli-auth", "9r-cli-auth"]
        : ["9r-cli-auth", "rc-cli-auth"];

      for (const salt of salts) {
        const expectedToken = await getCachedTokenForSalt(salt);
        if (!expectedToken) continue;

        const provided = Buffer.from(token, "utf8");
        const expected = Buffer.from(expectedToken, "utf8");
        if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
          return true;
        }
      }
    }

    return false;
  } catch {
    return false;
  }
}
