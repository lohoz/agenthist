import { DatabaseSync } from "node:sqlite";

export function createCodexTargetDatabase(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      archived INTEGER NOT NULL,
      first_user_message TEXT NOT NULL,
      model TEXT NOT NULL,
      memory_mode TEXT NOT NULL
    )
  `);
  database.close();
}
