// Event hook: pane.agent_status_changed
// Records agent done/blocked notifications in the shared state file.
// The list itself is a floating popup the user toggles with option+o —
// this hook NEVER opens it (default closed, per design).
// Any other state (agent resumed working, went idle) drops the entry so
// the list only shows panes waiting for the user right now.
"use strict";
const { mutateState } = require("./lib");

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
      workspace_id: context.workspace_id || data.workspace_id || null,
      at: now.toISOString(),
      seq: state.seq,
    };
    state.notifications = state.notifications.filter((n) => n.pane_id !== paneId);
    state.notifications.push(entry);
  });
}

main();
