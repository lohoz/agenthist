import * as Dialog from "@radix-ui/react-dialog";
import { ArrowUpRight, LoaderCircle, Search, X } from "lucide-react";
import { AgentLogo } from "./AgentLogo.js";
import { useEffect, useRef, useState } from "react";

import type { AgentHistDesktopApi, ChatSummaryDto } from "../../contracts.js";
import { AGENT_LABELS, classes, formatRelativeTime } from "../lib/display.js";

interface QuickSearchProps {
  readonly api: AgentHistDesktopApi;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onChoose: (chat: ChatSummaryDto) => void;
}

export function QuickSearch({ api, open, onClose, onChoose }: QuickSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly ChatSummaryDto[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const requestSequence = useRef(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    setError(undefined);
  }, [open]);

  useEffect(() => {
    if (!open) {
      requestSequence.current += 1;
      setLoading(false);
      setQuery("");
      setResults([]);
      setSelected(0);
      setError(undefined);
      return;
    }
    const sequence = ++requestSequence.current;
    let active = true;
    setLoading(true);
    setError(undefined);
    setResults([]);
    const timeout = window.setTimeout(() => {
      const trimmed = query.trim();
      void (async () => {
        try {
          const result = await api.listChats({ ...(trimmed === "" ? {} : { query: trimmed }), offset: 0, limit: 12 });
          if (!active || sequence !== requestSequence.current) return;
          setLoading(false);
          if (!result.ok) {
            setError(result.error.message);
            setResults([]);
            return;
          }
          setError(undefined);
          setResults(result.value.chats);
          setSelected(0);
        } catch {
          if (!active || sequence !== requestSequence.current) return;
          setLoading(false);
          setResults([]);
          setError("桌面桥接没有完成搜索请求。");
        }
      })();
    }, query === "" ? 0 : 120);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [api, open, query]);

  const choose = (chat: ChatSummaryDto | undefined): void => {
    if (chat === undefined) return;
    onChoose(chat);
    onClose();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-backdrop quick-search-layer" />
        <Dialog.Content
          className="quick-search"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
        >
        <Dialog.Title className="visually-hidden">快速搜索</Dialog.Title>
        <div className="quick-search-input">
          <Search size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索对话…"
            aria-label="快速搜索对话"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelected((value) => results.length === 0 ? 0 : Math.min(results.length - 1, value + 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((value) => Math.max(0, value - 1));
              }
              if (event.key === "Enter" && !loading) choose(results[selected]);
            }}
          />
          {loading ? <LoaderCircle className="spin" size={16} aria-label="正在搜索" /> : (
            <Dialog.Close asChild><button type="button" aria-label="关闭快速搜索"><X size={16} /></button></Dialog.Close>
          )}
        </div>
        <div className="quick-results" role="listbox" aria-label="对话搜索结果">
          {error === undefined ? null : <p className="quick-message" role="alert">{error}</p>}
          {!loading && error === undefined && results.length === 0 ? (
            <p className="quick-message">没有找到对话。</p>
          ) : null}
          {results.map((chat, index) => (
            <button
              type="button"
              role="option"
              aria-selected={selected === index}
              className={classes("quick-result", selected === index && "is-selected")}
              key={chat.sessionRef}
              onMouseEnter={() => setSelected(index)}
              onClick={() => choose(chat)}
            >
              <span className="agent-glyph"><AgentLogo agent={chat.agent} /></span>
              <span className="quick-result-copy">
                <strong>{chat.title || "未命名对话"}</strong>
                <small>{chat.workspaceName} · {AGENT_LABELS[chat.agent]} · {formatRelativeTime(chat.updatedAt)}</small>
              </span>
              <ArrowUpRight size={15} aria-hidden="true" />
            </button>
          ))}
        </div>
        <footer className="quick-search-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>Enter</kbd> 打开</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
