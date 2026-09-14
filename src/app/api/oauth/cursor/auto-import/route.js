import { NextResponse } from "next/server";
import { access, constants } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const ACCESS_TOKEN_KEYS = ["cursorAuth/accessToken", "cursorAuth/token"];
const MACHINE_ID_KEYS = [
  "storage.serviceMachineId",
  "storage.machineId",
  "telemetry.machineId",
];

/** Get candidate db paths by platform */
function getCandidatePaths(platform) {
  const home = homedir();

  if (platform === "darwin") {
    return [
      join(
        home,
        "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
      ),
      join(
        home,
        "Library/Application Support/Cursor - Insiders/User/globalStorage/state.vscdb",
      ),
    ];
  }

  if (platform === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    const localAppData =
      process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return [
      join(appData, "Cursor", "User", "globalStorage", "state.vscdb"),
      join(
        appData,
        "Cursor - Insiders",
        "User",
        "globalStorage",
        "state.vscdb",
      ),
      join(localAppData, "Cursor", "User", "globalStorage", "state.vscdb"),
      join(
        localAppData,
        "Programs",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      ),
    ];
  }

  return [join(home, ".config/Cursor/User/globalStorage/state.vscdb")];
}

const normalize = (value) => {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
};

/**
 * Extract tokens via better-sqlite3 (bundled dependency).
 * This is the preferred strategy — no external CLI required.
 */
async function extractTokensViaBetterSqlite(dbPath) {
  // Dynamic import keeps the route importable when native bindings are absent.
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  const query = (key) => {
    const statement = db.prepare("SELECT key, value FROM itemTable WHERE key IN (?) LIMIT 1");
    if (typeof statement.get === "function") return statement.get(key)?.value || null;
    const rows = typeof statement.all === "function" ? statement.all(key) : [];
    const row = rows.find((item) => item?.key === key) || rows[0];
    return row?.value || null;
  };

  const normalize = (value) => {
    if (typeof value !== "string") return value;
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" ? parsed : value;
    } catch {
      return value;
    }
  };

  try {
    let accessToken = null;
    for (const key of ACCESS_TOKEN_KEYS) {
      const raw = query(key);
      if (raw) { accessToken = normalize(raw); break; }
    }

    let machineId = null;
    for (const key of MACHINE_ID_KEYS) {
      const raw = query(key);
      if (raw) { machineId = normalize(raw); break; }
    }

    // Cursor forks have used different key names over time. Keep the exact
    // lookup fast, then use a conservative macOS-only fuzzy fallback.
    if (!accessToken || !machineId) {
      const statement = db.prepare(
        "SELECT key, value FROM itemTable WHERE key LIKE ? OR key LIKE ?",
      );
      const rows = typeof statement.all === "function"
        ? statement.all("%accessToken%", "%machineId%")
        : [];
      for (const row of rows) {
        const key = String(row?.key || "").toLowerCase();
        const value = normalize(row?.value);
        if (!accessToken && key.includes("accesstoken") && value) accessToken = value;
        if (!machineId && key.includes("machineid") && value) machineId = value;
      }
    }

    return { accessToken, machineId };
  } finally {
    db.close();
  }
}

/**
 * Extract tokens via sqlite3 CLI.
 * Fallback when better-sqlite3 native bindings are unavailable.
 */
async function extractTokensViaCLI(dbPath) {
  const normalize = (raw) => {
    const value = raw.trim();
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" ? parsed : value;
    } catch {
      return value;
    }
  };

  const query = async (sql) => {
    const { stdout } = await execFileAsync("sqlite3", [dbPath, sql], {
      timeout: 10000,
    });
    return stdout.trim();
  };

  // Try each key in priority order
  let accessToken = null;
  for (const key of ACCESS_TOKEN_KEYS) {
    try {
      const raw = await query(
        `SELECT value FROM itemTable WHERE key='${key}' LIMIT 1`,
      );
      if (raw) {
        accessToken = normalize(raw);
        break;
      }
    } catch {
      /* try next */
    }
  }

  let machineId = null;
  for (const key of MACHINE_ID_KEYS) {
    try {
      const raw = await query(
        `SELECT value FROM itemTable WHERE key='${key}' LIMIT 1`,
      );
      if (raw) {
        machineId = normalize(raw);
        break;
      }
    } catch {
      /* try next */
    }
  }

  return { accessToken, machineId };
}

/**
 * GET /api/oauth/cursor/auto-import
 * Auto-detect and extract Cursor tokens from local SQLite database.
 * Strategy: better-sqlite3 → sqlite3 CLI → manual fallback
 */
export async function GET() {
  try {
    const platform = process.platform;
    if (!["darwin", "win32", "linux"].includes(platform)) {
      return NextResponse.json({ error: "Unsupported platform" }, { status: 400 });
    }
    const candidates = getCandidatePaths(platform);

    let dbPath = null;
    if (platform === "linux") {
      // Linux historically used a single path and let SQLite provide the
      // useful error; retain that behavior for CLI compatibility.
      dbPath = candidates[0];
    } else {
      for (const candidate of candidates) {
        try {
          await access(candidate, constants.R_OK);
          dbPath = candidate;
          break;
        } catch {
          // Try next candidate
        }
      }
    }

    if (!dbPath) {
      const error = platform === "darwin"
        ? "Cursor database not found in known macOS locations"
        : "Cursor database not found. Make sure Cursor IDE is installed and you are logged in.";
      return NextResponse.json({ found: false, error });
    }

    // Strategy 1: better-sqlite3 (bundled — no external tools required)
    let betterSqliteError = null;
    try {
      const tokens = await extractTokensViaBetterSqlite(dbPath);
      if (tokens.accessToken && tokens.machineId) {
        return NextResponse.json({
          found: true,
          accessToken: tokens.accessToken,
          machineId: tokens.machineId,
        });
      }
    } catch (error) {
      betterSqliteError = error;
      // Native bindings unavailable — try CLI fallback
    }

    // Strategy 2: sqlite3 CLI
    try {
      const tokens = await extractTokensViaCLI(dbPath);
      if (tokens.accessToken && tokens.machineId) {
        return NextResponse.json({
          found: true,
          accessToken: tokens.accessToken,
          machineId: tokens.machineId,
        });
      }
    } catch {
      // sqlite3 CLI not available either
    }

    if (platform !== "linux" && betterSqliteError && /CANTOPEN|unable to open/i.test(betterSqliteError.message || "")) {
      return NextResponse.json({
        found: false,
        error: `Cursor database could not open it: ${betterSqliteError.message}`,
      });
    }

    return NextResponse.json({
      found: false,
      error: platform === "darwin"
        ? "Please login to Cursor IDE first"
        : "Cursor database not found. Make sure Cursor IDE is installed and you are logged in.",
    });
  } catch (error) {
    console.log("Cursor auto-import error:", error);
    return NextResponse.json(
      { found: false, error: error.message },
      { status: 500 },
    );
  }
}
