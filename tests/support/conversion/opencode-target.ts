import { DatabaseSync } from "node:sqlite";

export function createOpenCodeTargetDatabase(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      sandboxes TEXT NOT NULL
    );
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      path TEXT,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      cost REAL NOT NULL,
      agent TEXT NOT NULL,
      model TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
    INSERT INTO migration VALUES ('agenthist-test-schema-complete', 0);
  `);
  database.close();
}
