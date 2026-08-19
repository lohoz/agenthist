import type {
  ConversationGap,
  ConversationItem,
  ConversationMessage,
} from "../domain/history.js";

export const GAP_RUN_COLLAPSE_THRESHOLD = 4;

export interface ConversationGapCount {
  readonly code: string;
  readonly count: number;
}

export type ConversationDisplayGroup =
  | { readonly kind: "message"; readonly message: ConversationMessage }
  | {
      readonly kind: "gaps";
      readonly gaps: readonly ConversationGap[];
      readonly counts: readonly ConversationGapCount[];
    };

function gapCounts(gaps: readonly ConversationGap[]): ConversationGapCount[] {
  const counts = new Map<string, number>();
  for (const gap of gaps) {
    const code = gap.code ?? gap.label;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts].map(([code, count]) => ({ code, count }));
}

export function groupConversationForDisplay(
  conversation: readonly ConversationItem[],
): ConversationDisplayGroup[] {
  const groups: ConversationDisplayGroup[] = [];
  for (let index = 0; index < conversation.length;) {
    const item = conversation[index]!;
    if (item.kind === "message") {
      groups.push({ kind: "message", message: item });
      index++;
      continue;
    }
    const gaps: ConversationGap[] = [];
    let end = index;
    while (end < conversation.length) {
      const gap = conversation[end]!;
      if (gap.kind !== "gap") break;
      gaps.push(gap);
      end++;
    }
    groups.push({ kind: "gaps", gaps, counts: gapCounts(gaps) });
    index = end;
  }
  return groups;
}
