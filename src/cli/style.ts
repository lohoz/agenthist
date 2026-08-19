type AnsiStyle = "bold" | "dim" | "inverse" | "cyan" | "green" | "yellow" | "red";

export type TerminalRole =
  | "plain"
  | "strong"
  | "muted"
  | "brand"
  | "heading"
  | "pane_heading"
  | "section"
  | "section_divider"
  | "error_divider"
  | "divider"
  | "hint"
  | "step_current"
  | "step_complete"
  | "step_pending"
  | "focus"
  | "context"
  | "selected"
  | "info"
  | "success"
  | "warning"
  | "warning_strong"
  | "error"
  | "error_strong"
  | "message_user"
  | "message_assistant"
  | "message_system";

const ANSI_CODES: Readonly<Record<AnsiStyle, number>> = {
  bold: 1,
  dim: 2,
  inverse: 7,
  red: 31,
  green: 32,
  yellow: 33,
  cyan: 36,
};

const ROLE_STYLES: Readonly<Record<TerminalRole, readonly AnsiStyle[]>> = {
  plain: [],
  strong: ["bold"],
  muted: ["dim"],
  brand: ["bold"],
  heading: ["bold"],
  pane_heading: ["bold", "cyan"],
  section: ["bold", "cyan"],
  section_divider: ["dim", "cyan"],
  error_divider: ["dim", "red"],
  divider: ["dim"],
  hint: ["bold", "cyan"],
  step_current: ["bold", "cyan"],
  step_complete: ["green"],
  step_pending: ["dim"],
  focus: ["inverse", "bold"],
  context: ["bold", "cyan"],
  selected: [],
  info: ["cyan"],
  success: ["green"],
  warning: ["yellow"],
  warning_strong: ["bold", "yellow"],
  error: ["red"],
  error_strong: ["bold", "red"],
  message_user: ["bold", "cyan"],
  message_assistant: ["bold", "green"],
  message_system: ["bold", "yellow"],
};

export function paint(value: string, role: TerminalRole, enabled: boolean): string {
  const styles = ROLE_STYLES[role];
  if (!enabled || value === "" || styles.length === 0) return value;
  return `\u001b[${styles.map((style) => ANSI_CODES[style]).join(";")}m${value}\u001b[0m`;
}
