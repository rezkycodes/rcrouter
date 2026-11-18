const fs = require("fs");
const path = require("path");
const os = require("os");

const APP_NAME = "rcrouter";

function defaultDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();
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

const DATA_DIR = getDataDir();
const MITM_DIR = path.join(DATA_DIR, "mitm");

// The root CA created under the pre-rename directory is already trusted by the OS and its private
// key lives next to it, so carry it over once instead of minting a new CA. Stale pid/lock files are
// left behind: they would make this install believe an old (or a 9router) MITM process is its own.
function migrateLegacyMitmDir() {
  if (process.env.DATA_DIR || fs.existsSync(MITM_DIR)) return;
  const legacyBase = process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router")
    : path.join(os.homedir(), ".9router");
  const legacy = path.join(legacyBase, "mitm");
  if (!fs.existsSync(legacy)) return;
  try {
    fs.cpSync(legacy, MITM_DIR, {
      recursive: true, errorOnExist: false, force: true,
      filter: (src) => !/\.mitm\.(pid|lock)$/.test(src),
    });
  } catch (e) {
    console.warn(`[MITM] Could not copy ${legacy} to ${MITM_DIR}: ${e?.message || e}`);
  }
}
migrateLegacyMitmDir();
try { fs.mkdirSync(MITM_DIR, { recursive: true }); } catch {}

module.exports = { DATA_DIR, MITM_DIR };
