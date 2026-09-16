import { app } from "electron";
import { backup, DatabaseSync } from "node:sqlite";

if (typeof backup !== "function" || typeof DatabaseSync !== "function") {
  throw new Error("Electron does not expose the node:sqlite APIs required by AgentHist");
}

process.stdout.write(`${JSON.stringify({
  electron: process.versions.electron,
  node: process.versions.node,
  chrome: process.versions.chrome,
  sqliteBackup: typeof backup,
  sqliteDatabaseSync: typeof DatabaseSync,
})}\n`);

app.exit(0);
