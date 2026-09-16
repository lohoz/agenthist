import assert from "node:assert/strict";
import test from "node:test";
import { workspacePath } from "../../../src/domain/workspace-path.js";

test("workspace identity unifies Windows aliases without folding POSIX case", () => {
  const expected = workspacePath("D:\\demo-project");
  for (const input of ["d:/demo-project/", "\\\\?\\D:\\demo-project", "D:\\temp\\..\\DEMO-PROJECT\\."]) {
    assert.equal(workspacePath(input).key, expected.key);
  }
  assert.equal(workspacePath("\\\\?\\UNC\\server\\share\\project\\").key,
    workspacePath("\\\\SERVER\\share\\project").key);
  assert.equal(workspacePath("/work/project/").key, "posix:/work/project");
  assert.notEqual(workspacePath("/work/Project").key, workspacePath("/work/project").key);
  assert.deepEqual(workspacePath("C:/").segments, []);
  assert.equal(workspacePath("/").path, "/");
});
