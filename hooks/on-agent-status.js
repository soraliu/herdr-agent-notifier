// Event hook: pane.agent_status_changed
// Keeps one entry per pane. done/blocked -> visible notification + auto-open
// the strip pane (focus preserved, deduped via state.strip_pane_id);
// any other state (agent resumed working, went idle) -> drop the entry so the
// strip always shows panes waiting for the user right now.
"use strict";
const { mutateState, readState, writeState, rpc, findPaneId, withLockAsync } = require("./lib");

const PLUGIN_ID = "soraliu.agent-notifier";

async function paneAlive(paneId) {
  try {
    const res = await rpc(
      "pane.read",
      { pane_id: paneId, source: "visible", format: "text", lines: 1 },
      2000
    );
    return !(res && res.error);
  } catch (_err) {
    return false;
  }
}

// The strip is the persistent display surface. Hooks are the only place that
// can (re)open it: do so on every visible notification unless one is already
// showing. Serialized by the state lock so two concurrent done events for
// different panes cannot double-open.
async function ensureStripOpen() {
  await withLockAsync(async () => {
    const state = readState();
    if (state.strip_pane_id && (await paneAlive(state.strip_pane_id))) {
      return;
    }
    const res = await rpc(
      "plugin.pane.open",
      {
        plugin_id: PLUGIN_ID,
        entrypoint: "strip",
        placement: "split",
        direction: "down",
        focus: false,
      },
      2000
    );
    const paneId = findPaneId(res);
    if (!paneId) {
      throw new Error(`plugin.pane.open returned no pane id: ${JSON.stringify(res).slice(0, 200)}`);
    }
    state.strip_pane_id = paneId;
    writeState(state);
  });
}

async function main() {
  const envelope = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || "{}");
  // herdr passes the subscription-stream shape: event is the underscore
  // form ("pane_agent_status_changed") and data embeds a redundant type field.
  const eventName = envelope.event || (envelope.data && envelope.data.type) || "";
  if (eventName !== "pane_agent_status_changed" && eventName !== "pane.agent_status_changed") return;
  const data = envelope.data || {};
  const paneId = data.pane_id;
  const status = data.agent_status;
  if (!paneId || !status) return;
  // The event payload itself carries the agent label (richer than the hook context).
  const context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  const agent = data.agent || context.agent || context.agent_name || null;
  const visible = status === "done" || status === "blocked";
  mutateState((state) => {
    state.seq += 1;
    if (!visible) {
      state.notifications = state.notifications.filter((n) => n.pane_id !== paneId);
      return;
    }
    const now = new Date();
    const entry = {
      pane_id: paneId,
      agent,
      status,
      workspace_id: context.workspace_id || null,
      at: now.toISOString(),
      seq: state.seq,
    };
    state.notifications = state.notifications.filter((n) => n.pane_id !== paneId);
    state.notifications.push(entry);
  });
  if (!visible) return;
  try {
    await ensureStripOpen();
  } catch (err) {
    process.stderr.write(`agent-notifier: strip open failed: ${err.message}\n`);
  }
}

main();
