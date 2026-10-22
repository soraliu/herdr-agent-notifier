// Event hooks: pane.agent_status_changed + pane.exited
//
// Semantics: any completed turn (working -> idle/done) or blocked prompt is a
// notification, regardless of whether the user was watching that tab (herdr
// reports "idle" instead of "done" once a pane has been seen — we must not
// drop those). Entries are removed only by explicit user action (Enter/d/D in
// the popup) or when the pane exits. Initial idle (agent startup, no prior
// working) is not a notification.
"use strict";
const { mutateState } = require("./lib");

function main() {
  const envelope = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || "{}");
  // herdr passes the subscription-stream shape: event is the underscore
  // form ("pane_agent_status_changed") and data embeds a redundant type field.
  const eventName = envelope.event || (envelope.data && envelope.data.type) || "";
  const data = envelope.data || {};

  if (eventName === "pane_agent_exited" || eventName === "pane.exited") {
    const paneId = data.pane_id;
    if (!paneId) return;
    mutateState((state) => {
      state.seq += 1;
      state.working = (state.working || []).filter((p) => p !== paneId);
      state.notifications = state.notifications.filter((n) => n.pane_id !== paneId);
    });
    return;
  }
  if (eventName !== "pane_agent_status_changed" && eventName !== "pane.agent_status_changed") return;

  const paneId = data.pane_id;
  const status = data.agent_status;
  if (!paneId || !status) return;
  // The event payload itself carries the agent label (richer than the hook context).
  const context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  const agent = data.agent || context.agent || context.agent_name || null;

  mutateState((state) => {
    state.seq += 1;
    state.working = state.working || [];
    if (status === "working") {
      if (!state.working.includes(paneId)) state.working.push(paneId);
      return;
    }
    if (status === "blocked") {
      state.working = state.working.filter((p) => p !== paneId);
      upsertNotification(state, { paneId, agent, status, workspaceId: data.workspace_id || context.workspace_id || null });
      return;
    }
    // idle / done / unknown — terminal states.
    const completedTurn = state.working.includes(paneId);
    state.working = state.working.filter((p) => p !== paneId);
    if (!completedTurn) return; // initial idle / unknown noise — not a notification
    if (status === "unknown") return; // agent died mid-turn; pane.exited handles cleanup
    // Map idle to done for display: a completed turn that herdr reports as
    // idle (because the pane was already seen) is still a completion.
    const displayStatus = status === "idle" ? "done" : status;
    upsertNotification(state, { paneId, agent, status: displayStatus, workspaceId: data.workspace_id || context.workspace_id || null });
  });
}

function upsertNotification(state, { paneId, agent, status, workspaceId }) {
  const now = new Date();
  const entry = {
    pane_id: paneId,
    agent,
    status,
    workspace_id: workspaceId,
    at: now.toISOString(),
    seq: state.seq,
  };
  state.notifications = state.notifications.filter((n) => n.pane_id !== paneId);
  state.notifications.push(entry);
}

main();
