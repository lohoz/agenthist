import assert from "node:assert/strict";
import test from "node:test";

import {
  humanBytes,
  humanCount,
  humanFields,
  humanFieldWidth,
  humanOutputWidth,
  humanPage,
} from "../../../src/cli/human-output.js";
import {
  displayWidth,
  truncateDisplay,
  truncateDisplayAround,
} from "../../../src/cli/terminal-layout.js";

test("human output aligns fields and keeps pagination actionable", () => {
  assert.equal(
    humanFields([
      { label: "Status", value: "READY" },
      { label: "Workspace", value: "/work/project\n/work/second" },
    ], false),
    "  Status     READY\n  Workspace  /work/project\n             /work/second\n",
  );
  assert.equal(
    humanPage("session", 50, 25, 100, 75, false),
    "Showing 51-75 of 100 sessions. Next page: --offset 75\n",
  );
  assert.equal(humanCount(1, "session"), "1 session");
  assert.equal(humanCount(2, "session"), "2 sessions");
  assert.equal(humanBytes(51_074), "49.9 KiB");
  assert.equal(humanOutputWidth(undefined), 100);
  assert.equal(humanOutputWidth(38), 100);
  assert.equal(humanOutputWidth(80), 80);
});

test("human output shares field widths across record groups and truncates wide titles", () => {
  const summary = [{ label: "Status", value: "READY" }];
  const detail = [
    { label: "Status", value: "NOT DETECTED" },
    { label: "Native State Root", value: "/state" },
  ];
  const width = humanFieldWidth(summary, detail);
  assert.equal(
    humanFields(summary, false, "  ", width) + humanFields(detail, false, "  ", width),
    "  Status             READY\n  Status             NOT DETECTED\n  Native State Root  /state\n",
  );
  const title = truncateDisplay("这是一个很长的中文会话标题，用来验证终端宽度限制", 20);
  assert.ok(displayWidth(title) <= 20);
  assert.match(title, /\.\.\.$/);

  const snippet = truncateDisplayAround(
    `${"前文".repeat(40)}关键证据${"后文".repeat(40)}`,
    "关键证据",
    40,
  );
  assert.ok(displayWidth(snippet) <= 40);
  assert.match(snippet, /关键证据/);
  assert.match(snippet, /^\.\.\./);
  assert.match(snippet, /\.\.\.$/);
});
