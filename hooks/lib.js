// Shared helpers for herdr agent-notifier plugin: state file IO + socket RPC.
"use strict";
const fs = require("fs");
const path = require("path");
const net = require("net");

const os = require("os");
const STATE_DIR =
  process.env.HERDR_PLUGIN_STATE_DIR ||
  path.join(
    process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
    "herdr",
    "plugins",
    "soraliu.agent-notifier"
  );
const STATE_FILE = path.join(STATE_DIR, "notifications.json");

const MAX_NOTIFICATIONS = 20;

function emptyState() {
  return { strip_pane_id: null, seq: 0, notifications: [], working: [] };
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (parsed && Array.isArray(parsed.notifications)) {
      // migrate older states that predate the working set
      if (!Array.isArray(parsed.working)) parsed.working = [];
      return parsed;
    }
  } catch (_err) {
    // missing or corrupt -> fresh state
  }
  return emptyState();
}

// Atomic write so the strip TUI never reads a torn JSON.
function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  state.notifications = state.notifications.slice(-MAX_NOTIFICATIONS);
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}

// Hook invocations can race (working→done events arrive ~40ms apart, each
// spawning this script). Serialize read-modify-write with a mkdir lock;
// steal locks older than 5s in case a hook died holding one.
const LOCK_DIR = STATE_FILE + ".lock";
const LOCK_STALE_MS = 5000;

function withLock(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.mkdirSync(LOCK_DIR);
      try {
        return fn();
      } finally {
        fs.rmSync(LOCK_DIR, { recursive: true, force: true });
      }
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const stat = fs.statSync(LOCK_DIR);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(LOCK_DIR, { recursive: true, force: true });
          continue; // retry immediately after stealing the stale lock
        }
      } catch (_statErr) {
        continue; // lock vanished between mkdir and stat
      }
      if (attempt > 200) throw new Error("state lock timeout");
      const waitMs = 5 + Math.floor(Math.random() * 10);
      const start = Date.now();
      while (Date.now() - start < waitMs) {
        // busy-ish wait with jitter to desynchronize racing hooks
      }
    }
  }
}

function mutateState(mutator) {
  return withLock(() => {
    const state = readState();
    mutator(state);
    writeState(state);
    return state;
  });
}

// One-shot newline-delimited JSON request over the herdr socket.
function rpc(method, params, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socketPath = process.env.HERDR_SOCKET_PATH;
    if (!socketPath) {
      reject(new Error("HERDR_SOCKET_PATH not set"));
      return;
    }
    const socket = net.createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`rpc ${method} timeout`));
    }, timeoutMs);
    socket.on("connect", () => {
      socket.write(
        JSON.stringify({ id: `an-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, method, params }) + "\n"
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      clearTimeout(timer);
      socket.destroy();
      try {
        resolve(JSON.parse(buffer.slice(0, idx)));
      } catch (err) {
        reject(err);
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// Recursively dig the first pane_id out of a plugin.pane.open response;
// output shape differs slightly across versions, be liberal here.
function findPaneId(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.pane_id === "string") return value.pane_id;
  for (const key of Object.keys(value)) {
    const found = findPaneId(value[key]);
    if (found) return found;
  }
  return null;
}

// Async lock variant for operations that await RPCs while holding the lock.
// Same LOCK_DIR as the sync path, so hook mutations serialize with us.
async function withLockAsync(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.mkdirSync(LOCK_DIR);
      try {
        return await fn();
      } finally {
        fs.rmSync(LOCK_DIR, { recursive: true, force: true });
      }
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const stat = fs.statSync(LOCK_DIR);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch (_statErr) {
        continue;
      }
      if (attempt > 600) throw new Error("state lock timeout");
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 10)));
    }
  }
}

module.exports = {
  STATE_DIR,
  STATE_FILE,
  readState,
  writeState,
  mutateState,
  rpc,
  findPaneId,
  withLockAsync,
};
