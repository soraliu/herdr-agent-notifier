// Floating list (popup pane) of agents waiting for you (done/blocked).
// Toggled with option+o (plugin action "toggle"). Arrow keys / 1-9 select,
// Enter focuses the target pane and closes this popup asynchronously,
// d dismisses one, D clears all, q/Esc closes. Polls the state file.
"use strict";
const { readState, mutateState, rpc } = require("../hooks/lib");

// Minimal ANSI rendering, no dependencies.
const ESC = "\x1b[";
const HIDE_CURSOR = ESC + "?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR = ESC + "2J" + ESC + "H";
const STYLE = {
  done: { icon: "✔", color: "32" }, // green
  blocked: { icon: "●", color: "33" }, // yellow
};

let selected = 0;

function formatTime(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function render(state) {
  const lines = [];
  lines.push("\x1b[1magent-notifier\x1b[22m \x1b[2m(Enter 跳转 · d 清除 · D 清空 · q 关闭)\x1b[22m");
  const items = state.notifications || [];
  if (!items.length) {
    lines.push("\x1b[2m(no pending agents)\x1b[22m");
  }
  items.forEach((n, i) => {
    const style = STYLE[n.status] || { icon: "?", color: "37" };
    const marker = i === selected ? "\x1b[7m" : "";
    const reset = i === selected ? "\x1b[27m" : "";
    lines.push(
      `${marker}${style.icon}\x1b[${style.color}m ${String(i + 1).padStart(2)} ${n.agent || "agent"}\x1b[0m${reset} \x1b[2m${n.pane_id} ${formatTime(n.at)}\x1b[22m`
    );
  });
  process.stdout.write(CLEAR + lines.join("\r\n") + "\r\n");
}

// Jump-and-close: focus first, then fire-and-forget popup.close. Closing is
// async so the jump (pane.focus) is never delayed by popup teardown.
function jumpTo(items, index) {
  const item = items[index];
  if (!item) return;
  selected = index;
  rpc("pane.focus", { pane_id: item.pane_id })
    .then((res) => {
      if (res && res.error) {
        process.stderr.write(`pane.focus error: ${JSON.stringify(res.error)}\n`);
        return;
      }
      // Focus succeeded — remove the entry and close this popup (async, no await).
      mutateState((s) => {
        s.notifications = s.notifications.filter((n) => n.pane_id !== item.pane_id);
      });
      rpc("popup.close", {}, 3000).catch((err) => {
        process.stderr.write(`popup.close failed: ${err.message}\n`);
      });
    })
    .catch((err) => process.stderr.write(`pane.focus failed: ${err.message}\n`));
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
    const items = state.notifications || [];
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
    if (lastRaw === "1b5b41" && items.length) selected = (selected - 1 + items.length) % items.length; // up
    if (lastRaw === "1b5b42" && items.length) selected = (selected + 1) % items.length; // down
    if (/^[1-9]$/.test(text)) {
      const idx = parseInt(text, 10) - 1;
      if (idx < items.length) {
        jumpTo(items, idx);
      }
    }
    if (lastRaw === "0d" || lastRaw === "0a") {
      // enter (herdr sends CR; some terminals send LF)
      jumpTo(items, selected);
    }
    if (lastRaw === "64" && items.length) {
      // d
      const item = items[selected];
      mutateState((s) => {
        s.notifications = s.notifications.filter((n) => n.pane_id !== item.pane_id);
      });
    }
    if (lastRaw === "44") {
      // D
      mutateState((s) => {
        s.notifications = [];
      });
      selected = 0;
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
    const count = (state.notifications || []).length;
    if (selected >= count) selected = Math.max(0, count - 1);
    render(state);
  }, 500);

  render(readState());
}

main();
