import type { ConversionFinding } from "../../contracts.js";

const FINDING_LABELS: Readonly<Record<string, string>> = {
  "portable.lossy_text_fallback": "仅保留可读的用户与助手文本",
  "portable.lossy_content_omitted": "无法安全转换的内容已省略",
  "portable.messages.exact": "可读对话消息已完整保留",
  "portable.messages.empty": "没有可安全转换的可读消息",
  "claude.identity.synthesized": "Claude Code 会话标识已重建",
  "claude.session_identity.synthesized": "Claude Code 会话标识已重建",
  "claude.record_identity.synthesized": "Claude Code 消息标识已重建",
  "codex.session_identity.synthesized": "Codex 会话标识已重建",
  "codex.tool_state.skipped": "Codex 工具状态已省略",
  "opencode.session_row.synthesized": "OpenCode 会话记录已重建",
  "opencode.project_row.synthesized": "OpenCode 项目记录已重建",
  "opencode.message_rows.synthesized": "OpenCode 消息记录已重建",
  "opencode.part_rows.synthesized": "OpenCode 内容记录已重建",
  "pi.session_identity.synthesized": "Pi 会话标识已重建",
  "pi.entry_identity.synthesized": "Pi 消息标识已重建",
};

const FALLBACK_LABELS: Readonly<Record<ConversionFinding["disposition"], string>> = {
  exact: "相关对话内容已完整保留",
  synthesized: "目标 Agent 所需结构已安全重建",
  degraded: "相关内容已以兼容形式重建",
  skipped: "目标 Agent 不支持的相关内容已省略",
  blocked: "存在无法安全转换的相关内容",
};

export function conversionFindingLabel(
  finding: Pick<ConversionFinding, "code" | "disposition">,
): string {
  return FINDING_LABELS[finding.code] ?? FALLBACK_LABELS[finding.disposition];
}
