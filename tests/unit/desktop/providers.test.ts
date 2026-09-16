import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createDesktopService } from "../../../src/desktop/service.js";
import { rollbackNativeTransaction, listNativeTransactions } from "../../../src/application/transactions.js";
import { validateCodexProviderUnifyRequest, validateConfirmCodexProviderUnifyRequest } from "../../../src/desktop/validation.js";

test("provider requests accept IDs and plan references without exposing filesystem or credentials", () => {
  assert.deepEqual(validateCodexProviderUnifyRequest({ targetProvider: "current" }), { targetProvider: "current" });
  for (const targetProvider of ["", "https://example.test", "a b", "../other", "x".repeat(129)]) assert.throws(() => validateCodexProviderUnifyRequest({ targetProvider }));
  assert.throws(() => validateCodexProviderUnifyRequest({ targetProvider: "openai", codexHome: "C:\\other" }));
  assert.throws(() => validateConfirmCodexProviderUnifyRequest({ targetProvider: "openai", expectedPlanRef: "invalid" }));
});

test("desktop provider preview guards native changes, applies transactionally and supports rollback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthist-provider-ui-"));
  const state = path.join(root, "state");
  const home = path.join(root, "codex");
  const configPath = path.join(home, "config.toml");
  const authPath = path.join(home, "auth.json");
  const rollouts: string[] = [];
  const original: string[] = [];
  const service = createDesktopService({ stateDirectory: state, version: "test", sourceOptions: { codex: { codexHome: home, sqliteHome: home, home: root, environment: {} } } });
  try {
    await mkdir(home, { recursive: true });
    await writeFile(configPath, 'model_provider="target"\n');
    await writeFile(authPath, '{"OPENAI_API_KEY":"synthetic-secret"}');
    const database = new DatabaseSync(path.join(home, "history.sqlite"));
    database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, model_provider TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, archived INTEGER NOT NULL, first_user_message TEXT NOT NULL, model TEXT NOT NULL)");
    for (const [index, provider] of ["old", "target"].entries()) {
      const id = `10000000-0000-4000-8000-00000000000${index + 1}`;
      const file = path.join(home, index === 0 ? "sessions" : "archived_sessions", `rollout-${id}.jsonl`);
      await mkdir(path.dirname(file), { recursive: true });
      const text = [
        { timestamp: "2026-09-01T00:00:00.000Z", type: "session_meta", payload: { id, timestamp: "2026-09-01T00:00:00.000Z", cwd: root, originator: "fixture", cli_version: "fixture", model_provider: provider, model: "fixture-model" } },
        { timestamp: "2026-09-01T00:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `Synthetic task ${index}` }] } },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n";
      await writeFile(file, text); rollouts.push(file); original.push(text);
      database.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, file, 1788220800, 1788220801, provider, root, `Task ${index}`, index, `Task ${index}`, "fixture-model");
    }
    database.close();
    const listed = await service.listCodexProviders();
    assert.ok(listed.ok, JSON.stringify(listed));
    assert.equal(listed.value.totalSessions, 2);
    const preview = await service.previewCodexProviderUnify({ targetProvider: "current" });
    assert.ok(preview.ok, JSON.stringify(preview));
    assert.equal(preview.value.changed, 1);
    assert.equal(await readFile(rollouts[0]!, "utf8"), original[0]);
    assert.equal((await listNativeTransactions(state)).length, 0);
    await writeFile(configPath, 'model_provider="new-target"\n');
    const stale = await service.confirmCodexProviderUnify({ targetProvider: "current", expectedPlanRef: preview.value.planRef });
    assert.ok(stale.ok, JSON.stringify(stale));
    assert.equal(stale.value.status, "replan_required");
    assert.equal(await readFile(rollouts[0]!, "utf8"), original[0]);
    assert.equal((await listNativeTransactions(state)).length, 0);
    const confirmed = await service.confirmCodexProviderUnify({ targetProvider: "current", expectedPlanRef: stale.value.plan.planRef });
    assert.ok(confirmed.ok, JSON.stringify(confirmed));
    assert.equal(confirmed.value.status, "completed");
    if (confirmed.value.status !== "completed") throw new Error("not committed");
    assert.equal(confirmed.value.plan.changed, 2);
    assert.ok(confirmed.value.transactionRef);
    for (const file of rollouts) assert.equal(JSON.parse((await readFile(file, "utf8")).split("\n")[0]!).payload.model_provider, "new-target");
    assert.equal(await readFile(authPath, "utf8"), '{"OPENAI_API_KEY":"synthetic-secret"}');
    assert.equal(await readFile(configPath, "utf8"), 'model_provider="new-target"\n');
    await rollbackNativeTransaction(state, confirmed.value.transactionRef, true);
    for (const [index, file] of rollouts.entries()) assert.equal(await readFile(file, "utf8"), original[index]);
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true }); }
});
