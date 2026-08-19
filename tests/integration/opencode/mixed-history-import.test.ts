import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createOpenCodeHistoryDatabase,
  materializeOpenCodeConversionDatabase,
  mergeOpenCodeHistoryDatabases,
} from "../../../src/agents/opencode/storage/database.js";
import {
  applyOpenCodeInsertedRows,
  assessOpenCodeTarget,
} from "../../../src/agents/opencode/storage/native.js";

function createTargetShapedDatabase(file: string, withNativeSession: boolean, initialized = true): void {
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT,
      icon_url TEXT, icon_url_override TEXT, icon_color TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      time_initialized INTEGER, sandboxes TEXT NOT NULL, commands TEXT
    );
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT,
      slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT,
      title TEXT NOT NULL, version TEXT NOT NULL, share_url TEXT,
      summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
      summary_diffs TEXT, metadata TEXT, cost REAL DEFAULT 0 NOT NULL,
      tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL,
      tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_write INTEGER DEFAULT 0 NOT NULL, revert TEXT, permission TEXT,
      agent TEXT, model TEXT, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, time_compacting INTEGER, time_archived INTEGER,
      FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE
    );
    CREATE TABLE todo (
      session_id TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
      priority TEXT NOT NULL, position INTEGER NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      PRIMARY KEY (session_id, position),
      FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
    );
    CREATE TABLE event_sequence (
      aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, owner_id TEXT
    );
    CREATE TABLE event (
      id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL,
      type TEXT NOT NULL, data TEXT NOT NULL,
      FOREIGN KEY (aggregate_id) REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE
    );
    CREATE TABLE session_context_epoch (
      session_id TEXT PRIMARY KEY, baseline TEXT NOT NULL, snapshot TEXT NOT NULL,
      baseline_seq INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
    );
    CREATE TABLE session_input (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL,
      delivery TEXT NOT NULL, admitted_seq INTEGER NOT NULL, promoted_seq INTEGER,
      time_created INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
      seq INTEGER NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
    );
  `);
  if (initialized) {
    database.exec(`
      CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
      INSERT INTO migration VALUES ('agenthist-test-schema-complete', 0);
    `);
  }
  if (withNativeSession) {
    database.exec(`
      INSERT INTO project (
        id, worktree, vcs, name, icon_url, icon_url_override, icon_color,
        time_created, time_updated, time_initialized, sandboxes, commands
      ) VALUES ('global', '/source/native', NULL, NULL, NULL, NULL, NULL, 1000, 2000, NULL, '[]', NULL);
      INSERT INTO session (
        id, project_id, parent_id, slug, directory, path, title, version,
        model, time_created, time_updated
      ) VALUES (
        'ses_native', 'global', NULL, 'native', '/source/native', '.',
        'Native OpenCode session', 'test',
        '{"id":"gpt-5.4","providerID":"native-provider"}', 1000, 2000
      );
      INSERT INTO message VALUES (
        'msg_native', 'ses_native', 1000, 1000,
        '{"role":"user","model":{"providerID":"native-provider","modelID":"gpt-5.4"}}'
      );
      INSERT INTO part VALUES (
        'prt_native', 'msg_native', 'ses_native', 1000, 1000,
        '{"type":"text","text":"Native message"}'
      );
      INSERT INTO todo VALUES ('ses_native', 'Retain native task', 'pending', 'high', 0, 1000, 1000);
    `);
  }
  database.close();
}

function createConvertedDatabase(file: string): void {
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY);
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
      directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL,
      version TEXT NOT NULL, model TEXT, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, time_archived INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    INSERT INTO project VALUES ('global');
    INSERT INTO session VALUES (
      'ses_converted', 'global', NULL, '/source/converted', '.',
      'Converted session', 'agenthist-converted',
      '{"id":"gpt-5.4","providerID":"agenthist-converted"}', 3000, 4000, NULL
    );
    INSERT INTO message VALUES (
      'msg_converted', 'ses_converted', 3000, 3000,
      '{"role":"user","model":{"providerID":"agenthist-converted","modelID":"gpt-5.4"}}'
    );
    INSERT INTO part VALUES (
      'prt_converted', 'msg_converted', 'ses_converted', 3000, 3000,
      '{"type":"text","text":"Converted message"}'
    );
  `);
  database.close();
}

test("native and converted OpenCode closures merge against one target schema", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-opencode-mixed-"));
  try {
    const nativeRaw = path.join(root, "native-raw.sqlite");
    const nativeClosure = path.join(root, "native-closure.sqlite");
    const convertedRaw = path.join(root, "converted-raw.sqlite");
    const convertedClosure = path.join(root, "converted-closure.sqlite");
    const convertedMaterialized = path.join(root, "converted-materialized.sqlite");
    const merged = path.join(root, "merged.sqlite");
    const target = path.join(root, "target.sqlite");
    const uninitializedTarget = path.join(root, "uninitialized-target.sqlite");

    createTargetShapedDatabase(nativeRaw, true);
    createOpenCodeHistoryDatabase(nativeRaw, nativeClosure);
    createConvertedDatabase(convertedRaw);
    createOpenCodeHistoryDatabase(convertedRaw, convertedClosure);
    createTargetShapedDatabase(target, false);
    createTargetShapedDatabase(uninitializedTarget, false, false);

    materializeOpenCodeConversionDatabase(convertedClosure, nativeClosure, convertedMaterialized);

    const nativeDatabase = new DatabaseSync(nativeClosure, { readOnly: true, readBigInts: true });
    const convertedDatabase = new DatabaseSync(convertedMaterialized, { readOnly: true, readBigInts: true });
    try {
      assert.deepEqual(
        convertedDatabase.prepare("SELECT * FROM project WHERE id = 'global'").get(),
        nativeDatabase.prepare("SELECT * FROM project WHERE id = 'global'").get(),
      );
    } finally {
      convertedDatabase.close();
      nativeDatabase.close();
    }
    mergeOpenCodeHistoryDatabases([nativeClosure, convertedMaterialized], merged);

    assert.throws(
      () => assessOpenCodeTarget(merged, uninitializedTarget),
      /target OpenCode database is not initialized by OpenCode/,
    );

    const planned = assessOpenCodeTarget(merged, target);
    assert.deepEqual(
      planned.sessions.map((session) => [session.nativeId, session.classification]),
      [["ses_converted", "new"], ["ses_native", "new"]],
    );
    assert.equal(planned.conflicts.length, 0);

    applyOpenCodeInsertedRows(merged, target, planned.insertedRows, "present", false);
    const repeated = assessOpenCodeTarget(merged, target);
    assert.equal(repeated.sessions.every((session) => session.classification === "already_present"), true);

    const database = new DatabaseSync(target, { readOnly: true });
    try {
      assert.equal((database.prepare("SELECT count(*) AS count FROM session").get() as { count: number }).count, 2);
      assert.equal((database.prepare("SELECT count(*) AS count FROM todo").get() as { count: number }).count, 1);
      assert.equal((database.prepare("SELECT count(*) AS count FROM session_message").get() as { count: number }).count, 0);
      const migration = database.prepare("SELECT id, time_completed FROM migration").get() as {
        id: string;
        time_completed: number;
      };
      assert.equal(migration.id, "agenthist-test-schema-complete");
      assert.equal(migration.time_completed, 0);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
