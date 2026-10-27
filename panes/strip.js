"use strict";
// Floating popup with two tabs (toggled with option+o, plugin action "toggle"):
//
//   recently agents (default) — every live agent pane, newest-opened first
//     (open time = pane.agent_detected time recorded in state.recent).
//     Enter/1-9 jump to the pane; entries are a list, not a todo — jumping
//     never removes them.
//   notifications — agents waiting for you (done/blocked), newest first.
//     Enter/1-9 jump and clear the entry, d dismisses one, D clears all.
//
// Tab / Shift+Tab switch tabs. Arrow keys move within the active tab,
// Enter focuses the target pane and closes this popup asynchronously,
// q/Esc close.
//
// Layout: one entry = two lines. The main line answers "which agent did
// what" at a glance (status icon, agent type, session name or pane task);
// the detail line answers "where" (workspace/tab, cwd, session id).
// Long lists scroll a viewport so the header and hint always stay visible.
//
// Data: the state file (notifications + recent) is polled every 500ms;
// a `session.snapshot` RPC every 2s enriches recent entries with live
// agent status / titles / labels and reconciles state.recent against the
// set of live agent panes. Session names are read from the agent session
// jsonl with an mtime-gated cache (reads are throttled per path).
const fs = require("fs");
const { readState, mutateState, rpc, readSessionName, shortSession } = require("../hooks/lib");

// Minimal ANSI rendering, no dependencies.
const ESC = "\x1b[";
const HIDE_CURSOR = ESC + "?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR = ESC + "2J" + ESC + "H";
const STYLE = {
  working: { icon: "◐", color: "36" },
  blocked: { icon: "●", color: "33" },
  done: { icon: "✔", color: "32" },
  idle: { icon: "○", color: "32" },
  unknown: { icon: "?", color: "37" },
};

let activeTab = "recent"; // default tab per spec
const sel = { recent: 0, notif: 0 };
const scroll = { recent: 0, notif: 0 };

// Live session data, refreshed from session.snapshot every LIVE_POLL_MS.
// Kept between polls so rendering never blocks on the socket.
let live = { agents: [], wsLabel: new Map(), tabLabel: new Map(), ready: false };
const LIVE_POLL_MS = 2000;

// Session-name cache: path -> {mtimeMs, name, lastRead}. Re-read only when
// the file's mtime moved AND the throttle window passed (agents append to
// their jsonl constantly; re-scanning on every poll would be pure IO waste).
const SESSION_NAME_REREAD_MS = 10000;
const sessionNames = new Map();

function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = (n) => String(n).padStart(2, "0");
  return sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

// Approximate terminal-cell width (CJK & emoji ≈ 2, zero-width joiners ≈ 0).
function textWidth(str) {
  let width = 0;
  for (const ch of String(str || "")) {
    const code = ch.codePointAt(0);
    if (code === 0x200d) continue; // ZWJ (emoji sequences)
    if (code >= 0x1f300 && code <= 0x1f9ff) width += 2;
    else if (code >= 0x1f000 && code <= 0x1f2ff) width += 2;
    else if (code >= 0x1100 && code <= 0x115f) width += 2; // Hangul Jamo
    else if (code >= 0x2e80 && code <= 0xa4cf) width += 2; // CJK
    else if (code >= 0xac00 && code <= 0xd7a3) width += 2; // Hangul
    else if (code >= 0xf900 && code <= 0xfaff) width += 2; // CJK compat
    else if (code >= 0xfe30 && code <= 0xfe4f) width += 2; // CJK compat forms
    else if (code >= 0xff00 && code <= 0xff60) width += 2; // fullwidth forms
    else if (code >= 0xffe0 && code <= 0xffe6) width += 2;
    else width += 1;
  }
  return width;
}

function ellipsize(str, max) {
  const s = String(str || "");
  if (textWidth(s) <= max) return s;
  let out = "";
  let width = 0;
  for (const ch of s) {
    const w = ch.codePointAt(0) >= 0x1100 ? 2 : 1; // cheap; textWidth gates
    if (width + w > max - 1) return out + "…";
    out += ch;
    width += w;
  }
  return out;
}

function padEnd(str, width) {
  const pad = width - textWidth(str);
  return pad > 0 ? str + " ".repeat(pad) : str;
}

// Strip the agent's own prefix from a live pane title so the task text
// stands alone: "π > 🎓 ACADEM: Research…" → "🎓 ACADEM: Research…".
function cleanTitle(title) {
  return String(title || "")
    .replace(/^\s*(?:π\s*>|π>|omp\s*>|π|>|\$)\s*/u, "")
    .trim();
}

function collapseHome(path) {
  const p = String(path || "");
  const home = process.env.HOME;
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

function paneWidth() {
  return process.stdout.columns || 100;
}

function sessionNameFor(path) {
  let stat;
  try {
    stat = fs.statSync(path);
  } catch (_err) {
    return null;
  }
  const cached = sessionNames.get(path);
  const now = Date.now();
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.name;
  if (cached && now - cached.lastRead < SESSION_NAME_REREAD_MS) return cached.name;
  const name = readSessionName(path);
  sessionNames.set(path, { mtimeMs: stat.mtimeMs, name, lastRead: now });
  return name;
}

// Build the display entry for one recent record. Returns null when the pane
// is no longer a live agent pane (closed, or agent left) — those are not
// renderable and not jumpable, so the list simply skips them.
function buildRecentEntry(rec) {
  const a = live.agents.find((x) => x.pane_id === rec.pane_id);
  if (!a) return null;
  const sessionPath =
    a.agent_session && typeof a.agent_session.value === "string" && /\.jsonl?$/i.test(a.agent_session.value)
      ? a.agent_session.value
      : null;
  return {
    pane_id: rec.pane_id,
    agent: a.agent || rec.agent,
    status: String(a.agent_status || "unknown").toLowerCase(),
    at: rec.at,
    pane_title: a.terminal_title || null,
    cwd: a.cwd || a.foreground_cwd || null,
    workspace: live.wsLabel.get(a.workspace_id) || null,
    tab: live.tabLabel.get(a.tab_id) || null,
    session: sessionPath ? shortSession(sessionPath) : null,
    session_name: sessionPath ? sessionNameFor(sessionPath) : null,
  };
}

function recentEntries(state) {
  // Newest-opened first: at is an ISO timestamp, so string comparison is
  // chronological. Mutations (jump keys) index the same sorted array.
  const recs = [...(state.recent || [])].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const out = [];
  for (const rec of recs) {
    const entry = buildRecentEntry(rec);
    if (entry) out.push(entry);
  }
  return out;
}

function notifEntries(state) {
  return [...(state.notifications || [])].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

function activeItems(state) {
  return activeTab === "recent" ? recentEntries(state) : notifEntries(state);
}

// Keep the selection inside the list and the selected entry inside the
// viewport. Header (1 line) + hint (1 line) bound the entry area; each
// entry renders as two lines.
function visibleWindow(items, tab) {
  const rows = process.stdout.rows || 24;
  // header + hint always occupy one line each; when the list overflows,
  // the "… N more" indicator needs one more.
  let maxEntries = Math.floor((rows - 2) / 2);
  if (items.length > maxEntries) maxEntries = Math.floor((rows - 3) / 2);
  maxEntries = Math.max(1, maxEntries);
  if (sel[tab] >= items.length) sel[tab] = Math.max(0, items.length - 1);
  if (sel[tab] < scroll[tab]) scroll[tab] = sel[tab];
  if (sel[tab] > scroll[tab] + maxEntries - 1) scroll[tab] = sel[tab] - maxEntries + 1;
  if (scroll[tab] < 0) scroll[tab] = 0;
  return { start: scroll[tab], count: maxEntries };
}

function tabLabel(active, label, count) {
  return active ? `\x1b[7m ${label} (${count}) \x1b[27m` : `\x1b[2m ${label} (${count}) \x1b[22m`;
}

function render(state) {
  const width = paneWidth();
  const lines = [];
  const notifs = notifEntries(state);
  const recents = recentEntries(state);
  const items = activeTab === "recent" ? recents : notifs;
  const { start, count } = visibleWindow(items, activeTab);

  // ---- header: title + tab bar ---------------------------------------
  lines.push(
    `\x1b[1magent-notifier\x1b[22m ` +
      tabLabel(activeTab === "recent", "recently agents", recents.length) +
      ` ` +
      tabLabel(activeTab === "notif", "notifications", notifs.length)
  );

  if (!items.length) {
    lines.push(`\x1b[2m${activeTab === "recent" ? "(no recent agents)" : "(no pending agents)"}\x1b[22m`);
  }
  for (let i = start; i < Math.min(items.length, start + count); i++) {
    const n = items[i];
    const style = STYLE[n.status] || STYLE.unknown;
    const marker = i === sel[activeTab] ? "\x1b[7m" : "";
    const reset = i === sel[activeTab] ? "\x1b[27m" : "";

    // ---- main line: who did what ------------------------------------
    // Label priority: session name (auto/user-given) > live pane task >
    // agent type. This is the "at-a-glance" line.
    const task = cleanTitle(n.pane_title);
    const fallback = n.status === "blocked" ? "waiting for input" : n.status === "working" ? "working…" : "finished";
    const mainLabel = n.session_name || task || fallback;
    const right = `${n.pane_id} ${formatTime(n.at)}`;
    const indent = "  ";
    const left = `${indent}${style.icon} ${String(i + 1).padStart(2)} ${n.agent || "?"} `;
    const leftWidth = textWidth(left);
    const budget = Math.max(10, width - leftWidth - textWidth(right) - 2);
    const labelCell = padEnd(ellipsize(mainLabel, budget), budget);
    lines.push(`${marker}${left}${labelCell}\x1b[2m${right}\x1b[22m${reset}`);

    // ---- detail line: where -----------------------------------------
    const where = [];
    if (n.workspace && n.tab && n.workspace !== n.tab) where.push(`${n.workspace} / ${n.tab}`);
    else if (n.workspace || n.tab) where.push(n.workspace || n.tab);
    const cwd = collapseHome(n.cwd);
    if (cwd) where.push(cwd);
    if (n.session) where.push(n.session);
    // If the session name exists AND the live pane task adds something
    // different, show the task too — it often carries the fresher context.
    if (n.session_name && task && task !== n.session_name) where.unshift(task);
    if (where.length) {
      lines.push(`${marker}\x1b[2m${" ".repeat(6)}${ellipsize(where.join("  ·  "), width - 6)}\x1b[22m${reset}`);
    }
  }
  if (start + count < items.length) {
    lines.push(`\x1b[2m… ${items.length - start - count} more\x1b[22m`);
  }

  // ---- hint line ------------------------------------------------------
  lines.push(`\x1b[2mTab 切换 · Enter 跳转 · d 清除 · D 清空 · q 关闭\x1b[22m`);
  process.stdout.write(CLEAR + lines.join("\r\n") + "\r\n");
}

// Jump-and-close: focus first, then fire-and-forget popup.close. Closing is
// async so the jump (pane.focus) is never delayed by popup teardown. The
// notifications tab clears its entry on jump (todo semantics); the recently
// tab keeps entries (list semantics).
function jumpTo(items, index, opts = {}) {
  const item = items[index];
  if (!item) return;
  sel[activeTab] = index;
  rpc("pane.focus", { pane_id: item.pane_id })
    .then((res) => {
      if (res && res.error) {
        process.stderr.write(`pane.focus error: ${JSON.stringify(res.error)}\n`);
        return;
      }
      if (opts.clearEntry) {
        mutateState((s) => {
          s.notifications = (s.notifications || []).filter((n) => n.pane_id !== item.pane_id);
        });
      }
      rpc("popup.close", {}, 3000).catch(() => {});
    })
    .catch((err) => process.stderr.write(`pane.focus failed: ${err.message}\n`));
}

// Refresh the live snapshot and reconcile state.recent with it: agent panes
// that are already live but missing from recent (plugin just installed /
// upgraded / state lost) are backfilled with now as their open time; entries
// for panes that are no longer live agent panes are dropped. Runs only on a
// successful fetch so a socket hiccup never wipes the list.
async function refreshLive() {
  try {
    const response = await rpc("session.snapshot", {}, 3000);
    const snap = (response && response.result && response.result.snapshot) || {};
    const agents = Array.isArray(snap.agents) ? snap.agents : [];
    const wsLabel = new Map();
    for (const ws of Array.isArray(snap.workspaces) ? snap.workspaces : []) {
      if (ws && ws.workspace_id) wsLabel.set(ws.workspace_id, ws.label || ws.workspace_id);
    }
    const tabLabel = new Map();
    for (const t of Array.isArray(snap.tabs) ? snap.tabs : []) {
      if (t && t.tab_id) tabLabel.set(t.tab_id, t.label || t.tab_id);
    }
    live = { agents, wsLabel, tabLabel, ready: true };

    const liveIds = new Set(agents.map((a) => a.pane_id).filter(Boolean));
    mutateState((state) => {
      state.recent = state.recent || [];
      const before = state.recent.length;
      state.recent = state.recent.filter((r) => liveIds.has(r.pane_id));
      const known = new Set(state.recent.map((r) => r.pane_id));
      const now = new Date().toISOString();
      for (const a of agents) {
        if (!a.pane_id || !a.agent || known.has(a.pane_id)) continue;
        state.recent.push({ pane_id: a.pane_id, agent: a.agent, workspace_id: a.workspace_id || null, at: now });
      }
      if (state.recent.length !== before) state.seq += 1;
    });
  } catch (_err) {
    // socket unavailable (herdr restarting?): keep the last live data
  }
}

function main() {
  process.stdout.write(HIDE_CURSOR);
  process.on("exit", () => process.stdout.write(SHOW_CURSOR));

  // herdr spawns plugin panes through volta-shim; stdin may not be a TTY there.
  // setRawMode is optional: without it we lose keyboard interaction but keep
  // rendering + polling. Crash would kill the pane seconds after open.
  const interactive = typeof process.stdin.setRawMode === "function";
  // Grace period after open: the alt+o keypress that toggled us open gets
  // echoed into the popup's stdin (herdr routes the triggering key's bytes to
  // the newly focused pane). Swallow input arriving in this window or the
  // popup closes itself ~1s after opening (observed on pane spawn logs).
  const OPEN_GRACE_MS = 700;
  const openedAt = Date.now();
  // Bare ESC needs disambiguation: ESC-prefixed sequences (alt+o = ESC o,
  // arrow keys = ESC [ A…) can arrive as separate chunks. Hold a lone ESC for
  // a short window; if a follow-up chunk lands, merge and re-dispatch.
  const ESC_MERGE_MS = 80;
  let escHoldTimer = null;
  if (interactive) process.stdin.setRawMode(true);
  process.stdin.resume();
  const handleKey = (lastRaw, text) => {
    const state = readState();
    const items = activeItems(state);
    if (lastRaw === "03") process.exit(0); // ctrl+c
    // option+o / alt+o: the popup owns all keyboard input while open, so the
    // herdr keybinding cannot fire. Handle the toggle-off here ourselves.
    // Terminals send Alt+<key> as ESC-prefixed ("1b6f" for alt+o); some macOS
    // configs send the composed character instead, so match both.
    if (lastRaw === "1b6f") {
      rpc("popup.close", {}, 3000).catch(() => {});
      return;
    }
    if (lastRaw === "71") process.exit(0); // q
    if (lastRaw === "09" || lastRaw === "1b5b5a") {
      // Tab / Shift+Tab: cycle tabs
      activeTab = activeTab === "recent" ? "notif" : "recent";
    }
    if (lastRaw === "1b5b41" && items.length) sel[activeTab] = (sel[activeTab] - 1 + items.length) % items.length; // up
    if (lastRaw === "1b5b42" && items.length) sel[activeTab] = (sel[activeTab] + 1) % items.length; // down
    if (/^[1-9]$/.test(text)) {
      const idx = parseInt(text, 10) - 1;
      if (idx < items.length) {
        jumpTo(items, idx, { clearEntry: activeTab === "notif" });
      }
    }
    if (lastRaw === "0d" || lastRaw === "0a") {
      // enter (herdr sends CR; some terminals send LF)
      jumpTo(items, sel[activeTab], { clearEntry: activeTab === "notif" });
    }
    if (activeTab === "notif") {
      if (lastRaw === "64" && items.length) {
        // d
        const item = items[sel.notif];
        if (item) {
          mutateState((s) => {
            s.notifications = s.notifications.filter((n) => n.pane_id !== item.pane_id);
          });
        }
      }
      if (lastRaw === "44") {
        // D
        mutateState((s) => {
          s.notifications = [];
        });
        sel.notif = 0;
      }
    }
    render(readState());
  };
  process.stdin.on("data", (buf) => {
    // Swallow the open-echo window (the triggering key's own bytes).
    if (Date.now() - openedAt < OPEN_GRACE_MS) return;
    const hex = buf.toString("hex");
    if (hex === "1b") {
      // Bare ESC: hold briefly — a follow-up chunk means this was a prefix.
      escHoldTimer = setTimeout(() => process.exit(0), ESC_MERGE_MS);
      return;
    }
    if (escHoldTimer) {
      clearTimeout(escHoldTimer);
      escHoldTimer = null;
      handleKey("1b" + hex, "");
      return;
    }
    handleKey(hex, buf.toString());
  });

  setInterval(() => {
    const state = readState();
    const count = activeItems(state).length;
    if (sel[activeTab] > count) sel[activeTab] = Math.max(0, count - 1);
    render(state);
  }, 500);
  setInterval(refreshLive, LIVE_POLL_MS);

  // First live fetch in parallel with the first render; re-render on
  // arrival so backfilled recent entries show up without waiting a tick.
  refreshLive().then(() => render(readState()));
  render(readState());
}

main();
