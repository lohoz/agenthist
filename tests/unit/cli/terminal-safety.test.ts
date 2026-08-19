import assert from "node:assert/strict";
import test from "node:test";

import { failure, success } from "../../../src/cli/command-support.js";
import { sanitizeHumanOutput, sanitizeTerminalText } from "../../../src/cli/terminal-safety.js";

test("terminal text removes escape and control sequences without changing ordinary text", () => {
  const dangerous = "前文\u001b[2J后文\u001b]52;c;c2VjcmV0\u0007结尾\u009b1;1H!\r\b";
  assert.equal(sanitizeTerminalText(dangerous), "前文后文结尾!");
  assert.equal(sanitizeTerminalText("normal English\n正常中文\tvalue"), "normal English\n正常中文\tvalue");
  assert.equal(sanitizeTerminalText("before\u001b]0;unterminated"), "before");
});

test("human output preserves only AgentHist's terminal color sequences", () => {
  const safe = "\u001b[1;36mHeading\u001b[0m";
  assert.equal(sanitizeHumanOutput(safe), safe);
  assert.equal(sanitizeHumanOutput("\u001b[38;5;196munsafe\u001b[0m"), "unsafe\u001b[0m");
  assert.equal(sanitizeHumanOutput("left\u001b[3Aright"), "leftright");
});

test("human CLI results are sanitized while JSON retains the original data", () => {
  const value = "title\u001b[2J\u001b]52;c;c2VjcmV0\u0007visible";
  const human = success("history list", { value }, `${value}\n`, false);
  assert.equal(human.stdout, "titlevisible\n");

  const json = success("history list", { value }, `${value}\n`, true);
  assert.equal((JSON.parse(json.stdout) as { readonly data: { readonly value: string } }).data.value, value);

  const failed = failure("history show", new Error(value), false);
  assert.equal(failed.stderr, "agenthist: titlevisible\n");
});
