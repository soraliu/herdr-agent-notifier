// Event hooks: pane.agent_status_changed + pane.exited
//
// Semantics: any completed turn (working -> idle/done) or blocked prompt is a
// notification, regardless of whether the user was watching that tab (herdr
// reports "idle" instead of "done" once a pane has been seen — we must not
// drop those). Entries are removed only by explicit user action (Enter/d/D in
// the popup) or when the pane exits. Initial idle (agent startup, no prior
// working) is not a notification.
//
// Recorded entries are enriched best-effort: one `session.snapshot` RPC right
// after the state write fills agent type, cwd, pane title, tab and workspace
// labels; the agent session jsonl (path from agent_session) is scanned for
// its name. Every piece is optional — anything unavailable is simply skipped.
"use strict";
const fs = require("fs");
const { mutateState, rpc } = require("./lib");

// How much of a session jsonl to scan for title records. pi/omp append the
// name near the head of the file (session start / rename), so a 1 MiB prefix
// is plenty and keeps the hook fast even for huge sessions.
const SESSION_NAME_READ_BYTES = 1024 * 1024;

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
  const workspaceId = data.workspace_id || context.workspace_id || null;

  let recorded = false;
  mutateState((state) => {
    state.seq += 1;
    state.working = state.working || [];
    if (status === "working") {
      if (!state.working.includes(paneId)) state.working.push(paneId);
      return;
    }
    if (status === "blocked") {
      state.working = state.working.filter((p) => p !== paneId);
      upsertNotification(state, { paneId, agent, status, workspaceId });
      recorded = true;
      return;
    }
    // idle / done / unknown — terminal states.
    // `done` is itself a completion signal (herdr reports Idle+unseen as done),
    // so it records regardless of the working set — a missed `working` event
    // (server restart, state reset mid-run, hook race) must not drop it.
    // `idle` records only when a working turn was tracked.
    const completedTurn = state.working.includes(paneId);
    state.working = state.working.filter((p) => p !== paneId);
    if (status === "done") {
      upsertNotification(state, { paneId, agent, status: "done", workspaceId });
      recorded = true;
      return;
    }
    if (!completedTurn) return; // initial idle / unknown noise — not a notification
    if (status === "unknown") return; // agent died mid-turn; pane.exited handles cleanup
    // Map idle to done for display: a completed turn that herdr reports as
    // idle (because the pane was already seen) is still a completion.
    upsertNotification(state, { paneId, agent, status: "done", workspaceId });
    recorded = true;
  });

  if (recorded) enrichEntry(paneId).catch(() => {});
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

// Best-effort enrichment: one snapshot RPC, then a locked merge. Fields the
// snapshot cannot provide (pane already gone, no agent_session yet) are
// simply left unset — the strip skips missing pieces.
async function enrichEntry(paneId) {
  const snap = await rpc("session.snapshot", {}, 4000);
  const agents = snap && snap.agents;
  if (!Array.isArray(agents)) return;
  const agent = agents.find((a) => a.pane_id === paneId);
  const workspaces = Array.isArray(snap.workspaces) ? snap.workspaces : [];
  const tabs = Array.isArray(snap.tabs) ? snap.tabs : [];
  const panes = Array.isArray(snap.panes) ? snap.panes : [];
  const wsLabel = (id) => {
    const ws = workspaces.find((w) => w.workspace_id === id);
    return ws ? ws.label : null;
  };
  const tabLabel = (wsId, tabId) => {
    const tab = tabs.find((t) => t.tab_id === tabId && (t.workspace_id === wsId || !t.workspace_id));
    return tab ? tab.label : null;
  };

  // Session name lives in the agent's own session journal (jsonl title
  // records), not in the herdr snapshot — read it outside the state lock.
  let sessionName = null;
  let sessionId = null;
  const session = agent && agent.agent_session;
  if (session && typeof session.value === "string" && session.value) {
    if (/\.jsonl?$/i.test(session.value) && session.value.includes("/")) {
      sessionName = readSessionName(session.value);
      sessionId = shortSession(session.value);
    } else {
      sessionId = shortSession(session.value);
    }
  }

  mutateState((state) => {
    const entry = (state.notifications || []).find((n) => n.pane_id === paneId);
    if (!entry) return; // removed while we were fetching
    state.seq += 1;
    if (agent) {
      entry.agent = agent.agent || entry.agent;
      entry.pane_title = agent.terminal_title || null;
      entry.cwd = agent.cwd || agent.foreground_cwd || null;
      entry.workspace = wsLabel(agent.workspace_id) || null;
      entry.tab = tabLabel(agent.workspace_id, agent.tab_id) || null;
    } else {
      // Pane no longer reports agent info; fall back to pane list for titles.
      const pane = panes.find((p) => p.pane_id === paneId);
      if (pane) {
        entry.pane_title = pane.terminal_title || pane.title || null;
        entry.cwd = pane.cwd || null;
      }
      entry.workspace = wsLabel(entry.workspace_id) || null;
    }
    if (sessionName) entry.session_name = sessionName;
    if (sessionId) entry.session = sessionId;
  });
}

// Scan the head of a pi/omp session jsonl for the last non-empty title record
// (the session's auto or user-given name). Best-effort: unreadable or unnamed
// sessions yield null and the strip falls back to the pane title.
function readSessionName(jsonPath) {
  try {
    const fd = fs.openSync(jsonPath, "r");
    try {
      const buf = Buffer.alloc(SESSION_NAME_READ_BYTES);
      const { bytesRead } = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.toString("utf8", 0, bytesRead);
      let name = null;
      for (const line of text.split("\n")) {
        if (!line.startsWith('{"type":"title"') && !line.includes('"type": "title"')) continue;
        try {
          const record = JSON.parse(line);
          if (typeof record.title === "string" && record.title.trim()) name = record.title.trim();
        } catch (_err) {
          // torn first line of a concurrent write — ignore
        }
      }
      return name;
    } finally {
      fs.closeSync(fd);
    }
  } catch (_err) {
    return null;
  }
}

// `…/<dir>/2026-10-23T09-00-16-352Z_01a167fd-4e60-….jsonl` → `01a167fd`;
// raw session ids pass through trimmed to 8 chars.
function shortSession(value) {
  const base = String(value).split("/").pop() || String(value);
  const stem = base.replace(/\.jsonl?$/, "");
  const underscore = stem.split("_");
  if (underscore.length >= 2 && /^[0-9a-f]{8}/i.test(underscore[1])) {
    return underscore[1].slice(0, 8);
  }
  return stem.length > 8 ? stem.slice(0, 8) : stem;
}

main();
