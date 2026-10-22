// Strip pane: persistent list of agents waiting for you (done/blocked).
// Arrow keys / 1-9 select, Enter focuses the pane, d dismisses one, D clears
// all, q quits (opens again from the next event). Polls the state file.
"use strict";
const fs = require("fs");
const { STATE_FILE, readState, mutateState, rpc } = require("../hooks/lib");

// Minimal ANSI rendering, no dependencies: cursor off, alt-screen off.
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
  lines.push("\x1b[1magent-notifier\x1b[22m \x1b[2m(done/blocked panes · Enter 跳转 · d 清除 · D 清空 · q 退出)\x1b[22m");
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

function focusSelected(item) {
  if (!item) return;
  rpc("pane.focus", { pane_id: item.pane_id })
    .then((res) => {
      if (res && res.error) process.stderr.write(`pane.focus error: ${JSON.stringify(res.error)}\n`);
    })
    .catch((err) => process.stderr.write(`pane.focus failed: ${err.message}\n`));
}

function jumpTo(items, index) {
  const item = items[index];
  if (!item) return;
  selected = index;
  focusSelected(item);
  mutateState((s) => {
    s.notifications = s.notifications.filter((n) => n.pane_id !== item.pane_id);
  });
}

function main() {
  process.stdout.write(HIDE_CURSOR);
  process.on("exit", () => process.stdout.write(SHOW_CURSOR));

  let lastRaw = "";
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (buf) => {
    lastRaw = buf.toString("hex");
    const state = readState();
    const items = state.notifications || [];
    if (lastRaw === "03") process.exit(0); // ctrl+c
    if (lastRaw === "71" || lastRaw === "1b") process.exit(0); // q / esc
    if (lastRaw === "1b5b41" && items.length) selected = (selected - 1 + items.length) % items.length; // up
    if (lastRaw === "1b5b42" && items.length) selected = (selected + 1) % items.length; // down
    if (/^[1-9]$/.test(buf.toString())) {
      const idx = parseInt(buf.toString(), 10) - 1;
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
        s.notifications = s.notifications.filter((n) => n !== item);
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
