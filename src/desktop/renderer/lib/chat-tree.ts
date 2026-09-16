import { workspacePath } from "../../../domain/workspace-path.js";
import type { ChatSummaryDto } from "../../contracts.js";

export interface ChatFolder {
  readonly key: string;
  readonly workspace: string;
  readonly name: string;
  readonly root: boolean;
  readonly children: readonly ChatFolder[];
  readonly chats: readonly ChatSummaryDto[];
  readonly descendants: readonly ChatSummaryDto[];
}

interface MutableFolder {
  key: string;
  workspace: string;
  name: string;
  root: boolean;
  children: Map<string, MutableFolder>;
  chats: ChatSummaryDto[];
}

export function buildChatTree(chats: readonly ChatSummaryDto[]): readonly ChatFolder[] {
  const roots = new Map<string, MutableFolder>();
  const seen = new Set<string>();
  for (const chat of chats) {
    if (seen.has(chat.sessionRef)) continue;
    seen.add(chat.sessionRef);
    const parsed = workspacePath(chat.workspace);
    let siblings = roots;
    let current: MutableFolder | undefined;
    for (let index = 0; index <= parsed.segments.length; index++) {
      const workspace = parsed.root + parsed.segments.slice(0, index).join(parsed.separator);
      const key = `workspace:${workspacePath(workspace).key}`;
      current = siblings.get(key);
      if (current === undefined) {
        current = {
          key, workspace,
          name: index === 0 ? parsed.root.replace(/\\$/u, "") || parsed.root : parsed.segments[index - 1]!,
          root: index === 0, children: new Map(), chats: [],
        };
        siblings.set(key, current);
      }
      siblings = current.children;
    }
    current!.chats.push(chat);
  }
  const recentFirst = (left: ChatSummaryDto, right: ChatSummaryDto): number =>
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.sessionRef.localeCompare(right.sessionRef);
  const finish = (folder: MutableFolder): ChatFolder => {
    const children = [...folder.children.values()].map(finish).sort((left, right) =>
      recentFirst(left.descendants[0]!, right.descendants[0]!) || left.name.localeCompare(right.name, "zh-CN"));
    const ordered = [...folder.chats].sort(recentFirst);
    const descendants = [...ordered, ...children.flatMap((child) => child.descendants)].sort(recentFirst);
    // Compress empty single-child directories, but keep disks and workspaces visible.
    if (!folder.root && ordered.length === 0 && children.length === 1 && children[0]!.chats.length === 0) {
      const child = children[0]!;
      return { ...child, name: `${folder.name}${workspacePath(folder.workspace).separator}${child.name}` };
    }
    return { key: folder.key, workspace: folder.workspace, name: folder.name, root: folder.root, children, chats: ordered, descendants };
  };
  return [...roots.values()].map(finish).sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
}

export type ChatTreeRow =
  | { readonly type: "folder"; readonly key: string; readonly depth: number; readonly folder: ChatFolder }
  | { readonly type: "chat"; readonly key: string; readonly depth: number; readonly chat: ChatSummaryDto };

export function flattenChatTree(folders: readonly ChatFolder[], collapsed: ReadonlySet<string>, depth = 0): ChatTreeRow[] {
  return folders.flatMap((folder): ChatTreeRow[] => [
    { type: "folder", key: folder.key, depth, folder },
    ...(collapsed.has(folder.key) ? [] : [
      ...flattenChatTree(folder.children, collapsed, depth + 1),
      ...folder.chats.map((chat): ChatTreeRow => ({ type: "chat", key: `chat:${chat.sessionRef}`, depth: depth + 1, chat })),
    ]),
  ]);
}
