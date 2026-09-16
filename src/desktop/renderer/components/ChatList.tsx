import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Folder, FolderOpen, HardDrive, MessageSquareText } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { Agent, ChatSummaryDto } from "../../contracts.js";
import { AGENT_LABELS, classes, formatRelativeTime } from "../lib/display.js";
import { buildChatTree, flattenChatTree } from "../lib/chat-tree.js";
import { AgentLogo } from "./AgentLogo.js";

interface ChatListProps {
  readonly chats: readonly ChatSummaryDto[];
  readonly total: number;
  readonly selectedSessionRef: string | undefined;
  readonly selectedSessionRefs: ReadonlySet<string>;
  readonly selectionBusy: ReadonlySet<string>;
  readonly selectionEnabled: boolean;
  readonly loadingMore: boolean;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
  readonly emptyActions?: ReactNode;
  readonly onLoadMore: () => void;
  readonly onSelect: (chat: ChatSummaryDto) => void;
  readonly onToggleChatSelection: (chat: ChatSummaryDto, selected: boolean) => void;
  readonly onToggleWorkspaceSelection: (
    workspace: string,
    agent: Agent | undefined,
    chats: readonly ChatSummaryDto[],
    selected: boolean,
  ) => void;
}

function memberRefs(chats: readonly ChatSummaryDto[]): string[] {
  return [...new Set(chats.flatMap((chat) => chat.memberSessionRefs))];
}

function selectionState(chats: readonly ChatSummaryDto[], selected: ReadonlySet<string>): {
  readonly checked: boolean;
  readonly partial: boolean;
} {
  const references = memberRefs(chats);
  const selectedCount = references.filter((reference) => selected.has(reference)).length;
  return {
    checked: references.length > 0 && selectedCount === references.length,
    partial: selectedCount > 0 && selectedCount < references.length,
  };
}

export function ChatList({
  chats,
  total,
  selectedSessionRef,
  selectedSessionRefs,
  selectionBusy,
  selectionEnabled,
  loadingMore,
  emptyTitle,
  emptyDescription,
  emptyActions,
  onLoadMore,
  onSelect,
  onToggleChatSelection,
  onToggleWorkspaceSelection,
}: ChatListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const folders = useMemo(() => buildChatTree(chats), [chats]);
  const rows = useMemo(() => flattenChatTree(folders, collapsed), [collapsed, folders]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 30,
    overscan: 9,
    useFlushSync: false,
    getItemKey: (index) => rows[index]?.key ?? index,
    initialRect: { width: 360, height: 720 },
  });
  const virtualItems = virtualizer.getVirtualItems();
  const finalIndex = virtualItems.at(-1)?.index ?? -1;

  useEffect(() => {
    if (finalIndex >= rows.length - 5 && chats.length < total && !loadingMore) onLoadMore();
  }, [chats.length, finalIndex, loadingMore, onLoadMore, rows.length, total]);

  useEffect(() => {
    const selectedIndex = rows.findIndex((row) => row.type === "chat" && (row.chat.sessionRef === selectedSessionRef || row.chat.memberSessionRefs.includes(selectedSessionRef ?? "")));
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
  }, [rows, selectedSessionRef, virtualizer]);

  const toggleCollapsed = (key: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="chat-list-scroll chat-tree" ref={scrollRef} data-testid="chat-list-scroll" role="tree" aria-label="按目录浏览对话">
      <div className="virtual-list-spacer" style={{ height: virtualizer.getTotalSize() }}>
        {virtualItems.map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (row === undefined) return null;
          return (
            <div
              className={classes("virtual-list-row", `tree-row-${row.type}`)}
              key={virtualRow.key}
              data-index={virtualRow.index}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-label={row.type === "folder" ? row.folder.workspace : row.chat.title}
              aria-expanded={row.type === "folder" ? !collapsed.has(row.key) : undefined}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {row.type === "folder" ? (
                <FolderRow
                  depth={row.depth}
                  root={row.folder.root}
                  nodeKey={row.key}
                  label={row.folder.name}
                  path={row.folder.workspace}
                  count={row.folder.descendants.length}
                  chats={row.folder.descendants}
                  collapsed={collapsed.has(row.key)}
                  selected={selectedSessionRefs}
                  busy={selectionBusy.has(row.key)}
                  selectionEnabled={selectionEnabled}
                  onToggleCollapsed={toggleCollapsed}
                  onToggleSelection={(selected) => onToggleWorkspaceSelection(row.folder.workspace, undefined, row.folder.descendants, selected)}
                />
              ) : (
                <ChatRow
                  depth={row.depth}
                  chat={row.chat}
                  selected={(row.chat.sessionRef === selectedSessionRef || row.chat.memberSessionRefs.includes(selectedSessionRef ?? ""))}
                  checked={row.chat.memberSessionRefs.every((reference) => selectedSessionRefs.has(reference))}
                  partial={row.chat.memberSessionRefs.some((reference) => selectedSessionRefs.has(reference)) &&
                    !row.chat.memberSessionRefs.every((reference) => selectedSessionRefs.has(reference))}
                  selectionEnabled={selectionEnabled}
                  onSelect={onSelect}
                  onToggleSelection={onToggleChatSelection}
                />
              )}
            </div>
          );
        })}
      </div>
      {loadingMore ? <div className="list-tail-status">正在加载更多对话…</div> : null}
      {chats.length > 0 && chats.length === total ? <div className="list-tail-status">共 {total} 个对话</div> : null}
      {chats.length === 0 ? (
        <div className="empty-list">
          <MessageSquareText size={25} strokeWidth={1.5} aria-hidden="true" />
          <strong>{emptyTitle}</strong>
          <span>{emptyDescription}</span>
          {emptyActions}
        </div>
      ) : null}
    </div>
  );
}

function FolderRow({
  depth,
  root,
  nodeKey,
  label,
  path,
  count,
  chats,
  collapsed,
  selected,
  busy,
  selectionEnabled,
  onToggleCollapsed,
  onToggleSelection,
}: {
  readonly depth: number;
  readonly root: boolean;
  readonly nodeKey: string;
  readonly label: string;
  readonly path: string;
  readonly count: number;
  readonly chats: readonly ChatSummaryDto[];
  readonly collapsed: boolean;
  readonly selected: ReadonlySet<string>;
  readonly busy: boolean;
  readonly selectionEnabled: boolean;
  readonly onToggleCollapsed: (key: string) => void;
  readonly onToggleSelection: (selected: boolean) => void;
}) {
  const state = selectionState(chats, selected);
  return (
    <div className="chat-tree-folder" style={{ paddingLeft: depth * 12 + 3 }}>
      <button className="tree-expand-button" type="button" aria-label={`${collapsed ? "展开" : "折叠"}${label}`} aria-expanded={!collapsed} onClick={() => onToggleCollapsed(nodeKey)}>
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      </button>
      {selectionEnabled ? (
        <TreeCheckbox
          checked={state.checked}
          partial={state.partial}
          disabled={busy}
          label={`选择${label}中的全部对话`}
          onChange={onToggleSelection}
        />
      ) : null}
      <button className="tree-folder-label" type="button" title={path} onClick={() => onToggleCollapsed(nodeKey)}>
        {root ? <HardDrive size={15} /> : collapsed ? <Folder size={15} /> : <FolderOpen size={15} />}
        <strong>{label}</strong>
        <span>{count}</span>
      </button>
    </div>
  );
}

function ChatRow({ depth, chat, selected, checked, partial, selectionEnabled, onSelect, onToggleSelection }: {
  readonly depth: number;
  readonly chat: ChatSummaryDto;
  readonly selected: boolean;
  readonly checked: boolean;
  readonly partial: boolean;
  readonly selectionEnabled: boolean;
  readonly onSelect: (chat: ChatSummaryDto) => void;
  readonly onToggleSelection: (chat: ChatSummaryDto, selected: boolean) => void;
}) {
  return (
    <div className={classes("chat-tree-session", selected && "is-selected")} style={{ paddingLeft: depth * 12 + 28 }}>
      {selectionEnabled ? (
        <TreeCheckbox checked={checked} partial={partial} label={`选择对话：${chat.title || "未命名对话"}`} onChange={(next) => onToggleSelection(chat, next)} />
      ) : null}
      <button type="button" className={classes("chat-list-item", selected && "is-selected")} title={`${chat.title} · ${AGENT_LABELS[chat.agent]}`} aria-current={selected ? "true" : undefined} onClick={() => onSelect(chat)}>
        <AgentLogo agent={chat.agent} size={16} />
        <span className="chat-item-content">
          <span className="chat-item-topline">
            <strong>{chat.title || "未命名对话"}</strong>
            <time dateTime={chat.updatedAt}>{formatRelativeTime(chat.updatedAt)}</time>
          </span>
        </span>
      </button>
    </div>
  );
}

function TreeCheckbox({ checked, partial, disabled = false, label, onChange }: {
  readonly checked: boolean;
  readonly partial: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = partial;
  }, [partial]);
  return <input ref={ref} className="tree-checkbox" type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={(event) => onChange(event.currentTarget.checked)} />;
}
