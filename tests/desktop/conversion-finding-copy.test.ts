import { describe, expect, it } from "vitest";

import { conversionFindingLabel } from "../../src/desktop/renderer/lib/conversion-finding-copy.js";

describe("conversion finding copy", () => {
  it("uses shared Chinese copy for known conversion findings", () => {
    expect(conversionFindingLabel({
      code: "portable.messages.exact",
      disposition: "exact",
    })).toBe("可读对话消息已完整保留");
    expect(conversionFindingLabel({
      code: "codex.tool_state.skipped",
      disposition: "skipped",
    })).toBe("Codex 工具状态已省略");
  });

  it("uses a neutral disposition-specific label for future internal codes", () => {
    expect(conversionFindingLabel({
      code: "future.internal_payload.changed",
      disposition: "degraded",
    })).toBe("相关内容已以兼容形式重建");
    expect(conversionFindingLabel({
      code: "future.internal_payload.blocked",
      disposition: "blocked",
    })).toBe("存在无法安全转换的相关内容");
  });
});
