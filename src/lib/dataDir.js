import fs from "node:fs";
import path from "path";
import os from "os";

const APP_NAME = "rcrouter";

function getLegacyDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router");
  }
  return path.join(os.homedir(), ".9router");
}

function defaultDir() {
  const target = process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME)
    : path.join(os.homedir(), `.${APP_NAME}`);

  // Dual Directory Persistence:
  // If defaultDir() does not exist or has no db/data.sqlite,
  // check if legacy 9router db/data.sqlite exists.
  // If it exists, recursively copy legacy to target before returning.
  const targetDb = path.join(target, "db", "data.sqlite");
  if (!fs.existsSync(target) || !fs.existsSync(targetDb)) {
    const legacy = getLegacyDir();
    const legacyDb = path.join(legacy, "db", "data.sqlite");
    if (fs.existsSync(legacyDb)) {
      try {
        fs.mkdirSync(target, { recursive: true });
        fs.cpSync(legacy, target, { recursive: true, errorOnExist: false, force: true });
        console.log(`[DATA_DIR] Migrated existing 9router data from '${legacy}' to '${target}'`);
      } catch (err) {
        console.warn(`[DATA_DIR] Failed to copy data from '${legacy}' to '${target}':`, err?.message || err);
      }
    }
  }

  return target;
}

export function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();

  // On Windows, ignore Unix-style absolute paths (e.g. /var/lib/...) that come
  // from a Linux-targeted .env or Docker config — they are not valid here.
  if (process.platform === "win32" && /^\//.test(configured)) {
    console.warn(`[DATA_DIR] '${configured}' is a Unix path on Windows → fallback to default`);
    return defaultDir();
  }

  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      console.warn(`[DATA_DIR] '${configured}' not writable → fallback ~/.${APP_NAME}`);
      return defaultDir();
    }
    throw e;
  }
}

export const DATA_DIR = getDataDir();
