import crypto from "node:crypto";
import { getConsistentMachineId } from "@/shared/utils/machineId.js";
import { getSettings } from "@/lib/localDb";
import { verifyDashboardAuthToken } from "./dashboardSession.js";

export const CLI_TOKEN_HEADERS = ["x-rc-cli-token", "x-9r-cli-token"];
export const CLI_TOKEN_SALTS = ["rc-cli-auth", "9r-cli-auth"];

export async function isValidCliToken(request) {
  try {
    for (const header of CLI_TOKEN_HEADERS) {
      const cliToken = request.headers.get(header);
      if (typeof cliToken === "string" && cliToken.length > 0) {
        const provided = Buffer.from(cliToken, "utf8");
        for (const salt of CLI_TOKEN_SALTS) {
          const expected = await getConsistentMachineId(salt);
          if (typeof expected === "string" && expected.length > 0) {
            const expectedBuf = Buffer.from(expected, "utf8");
            if (provided.length === expectedBuf.length && crypto.timingSafeEqual(provided, expectedBuf)) {
              return true;
            }
          }
        }
      }
    }
  } catch {}
  return false;
}

export async function isAuthorizedDashboardRequest(request) {
  if (await isValidCliToken(request)) return true;
  if (await verifyDashboardAuthToken(request.cookies.get("auth_token")?.value)) return true;
  try {
    const settings = await getSettings();
    return settings.requireLogin === false;
  } catch {
    return false;
  }
}

export async function requireDashboardAuth(request) {
  return isAuthorizedDashboardRequest(request);
}
