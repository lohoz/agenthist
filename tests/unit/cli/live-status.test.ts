import assert from "node:assert/strict";
import test from "node:test";

import { createLiveStatus, withLiveStatus } from "../../../src/cli/live-status.js";

function terminalOutput(chunks: string[], isTTY = true, columns = 80): NodeJS.WritableStream & {
  readonly isTTY: boolean;
  readonly columns: number;
} {
  return {
    isTTY,
    columns,
    write(value: Uint8Array | string): boolean {
      chunks.push(String(value));
      return true;
    },
  } as NodeJS.WritableStream & { readonly isTTY: boolean; readonly columns: number };
}

test("live status updates one terminal line and clears it on completion", () => {
  const chunks: string[] = [];
  let now = 1_000;
  const status = createLiveStatus({
    output: terminalOutput(chunks, true, 36),
    enabled: true,
    color: false,
    message: "Preparing history scan",
    delayMilliseconds: 0,
    intervalMilliseconds: 60_000,
    now: () => now,
  });

  assert.equal(chunks.length, 1);
  assert.match(chunks[0]!, /^\r\u001b\[2K- Preparing history scan · 0\.0s$/);

  now = 2_250;
  status.update("[1/4] Scanning a very long Agent history source name");
  assert.equal(chunks.length, 2);
  assert.match(chunks[1]!, /^\r\u001b\[2K- \[1\/4\] Scanning .+ · 1\.3s$/);
  assert.ok(chunks[1]!.length < 50);

  status.stop();
  assert.equal(chunks.at(-1), "\r\u001b[2K");
});

test("live status stays silent outside an interactive human terminal", async () => {
  const redirected: string[] = [];
  const status = createLiveStatus({
    output: terminalOutput(redirected, false),
    enabled: true,
    color: false,
    message: "Exporting Agent history",
    delayMilliseconds: 0,
  });
  status.update("Still exporting");
  status.stop();
  assert.deepEqual(redirected, []);

  const json: string[] = [];
  const result = await withLiveStatus(
    { progressOutput: terminalOutput(json), environment: { TERM: "xterm" } },
    { json: true, color: false },
    "Inspecting history archive",
    async () => 42,
  );
  assert.equal(result, 42);
  assert.deepEqual(json, []);
});
