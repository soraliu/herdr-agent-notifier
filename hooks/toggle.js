// Action: toggle the notification list popup (bound to option+o / alt+o).
// Strategy: try plugin.pane.open; "ui_busy" means our popup is already open,
// so close it via popup.close. Anything else is a real error.
"use strict";
const { rpc } = require("./lib");

async function main() {
  let res;
  try {
    res = await rpc(
      "plugin.pane.open",
      {
        plugin_id: "soraliu.agent-notifier",
        entrypoint: "strip",
        placement: "popup",
        width: "50%",
        height: 12,
        focus: true,
      },
      3000
    );
  } catch (err) {
    process.stderr.write(`agent-notifier: toggle open failed: ${err.message}\n`);
    process.exit(1);
  }
  if (res && res.error) {
    if (res.error.code === "ui_busy") {
      // Popup already open (ours is the only popup user) — close it.
      try {
        await rpc("popup.close", {}, 3000);
      } catch (err) {
        process.stderr.write(`agent-notifier: popup close failed: ${err.message}\n`);
        process.exit(1);
      }
      return;
    }
    process.stderr.write(`agent-notifier: toggle error: ${JSON.stringify(res.error)}\n`);
    process.exit(1);
  }
}

main();
