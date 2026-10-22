// Event hook: pane.agent_status_changed
// Keeps one entry per pane. done/blocked -> visible notification;
// any other state (agent resumed working, went idle) -> drop the entry so the
// strip always shows panes waiting for the user right now.
"use strict";
const { mutateState } = require("./lib");

function main() {
  const envelope = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || "{}");
  if (envelope.event !== "pane.agent_status_changed") return;
  const data = envelope.data || {};
  const paneId = data.pane_id;
  const status = data.agent_status;
  if (!paneId || !status) return;

  const context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  const agent = context.agent || context.agent_name || null;

  const visible = status === "done" || status === "blocked";
  const changed = mutateState((state) => {
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

  // Notify the running strip by touching a separate signal file: the state file
  // itself may not change when only the seq moves.
  process.exit(changed ? 0 : 0);
}

main();
