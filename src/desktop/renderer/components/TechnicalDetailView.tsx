import { Check, Clipboard, LoaderCircle, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AgentHistDesktopApi,
  DesktopError,
  TechnicalDetailDto,
} from "../../contracts.js";
import type { ClipboardWriter } from "./MarkdownMessage.js";

const CHUNK_CHARACTERS = 64 * 1024;

interface TechnicalDetailViewProps {
  readonly api: AgentHistDesktopApi;
  readonly sessionRef: string;
  readonly itemIndex: number;
  readonly detail: TechnicalDetailDto;
  readonly writeClipboard: ClipboardWriter | undefined;
}

const browserClipboardWriter: ClipboardWriter = async (text) => {
  await navigator.clipboard.writeText(text);
};

export function TechnicalDetailView({
  api,
  sessionRef,
  itemIndex,
  detail,
  writeClipboard = browserClipboardWriter,
}: TechnicalDetailViewProps) {
  const previewCharacters = codePointCount(detail.detail);
  const initialOffset = detail.available && detail.truncated && previewCharacters < detail.totalCharacters
    ? previewCharacters
    : undefined;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(detail.detail);
  const [loadedCharacters, setLoadedCharacters] = useState(previewCharacters);
  const [totalCharacters, setTotalCharacters] = useState(detail.totalCharacters);
  const [nextOffset, setNextOffset] = useState<number | undefined>(initialOffset);
  const [unavailableReason, setUnavailableReason] = useState(detail.available ? undefined : detail.unavailableReason);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DesktopError>();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const generation = useRef(0);
  const expandedOnce = useRef(false);
  const nextOffsetRef = useRef<number | undefined>(initialOffset);
  const requestedOffsets = useRef(new Set<number>());
  const identity = `${sessionRef}:${itemIndex}:${detail.detailIndex}:${detail.id}`;

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const nextPreviewCharacters = codePointCount(detail.detail);
    const nextInitialOffset = detail.available && detail.truncated && nextPreviewCharacters < detail.totalCharacters
      ? nextPreviewCharacters
      : undefined;
    expandedOnce.current = false;
    nextOffsetRef.current = nextInitialOffset;
    requestedOffsets.current.clear();
    setOpen(false);
    setText(detail.detail);
    setLoadedCharacters(nextPreviewCharacters);
    setTotalCharacters(detail.totalCharacters);
    setNextOffset(nextInitialOffset);
    setUnavailableReason(detail.available ? undefined : detail.unavailableReason);
    setBusy(false);
    setError(undefined);
    setCopyState("idle");
    return () => {
      if (generation.current === currentGeneration) generation.current += 1;
    };
  }, [
    detail.available,
    detail.detail,
    detail.detailIndex,
    detail.id,
    detail.totalCharacters,
    detail.truncated,
    detail.unavailableReason,
    identity,
  ]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timeout = window.setTimeout(() => setCopyState("idle"), 1_500);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  const loadNext = useCallback(async (): Promise<void> => {
    if (!detail.available) return;
    const offset = nextOffsetRef.current;
    if (offset === undefined || requestedOffsets.current.has(offset)) return;
    requestedOffsets.current.add(offset);
    const requestGeneration = generation.current;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.getTechnicalDetail({
        sessionRef,
        itemIndex,
        detailIndex: detail.detailIndex,
        offset,
        limit: CHUNK_CHARACTERS,
      });
      if (requestGeneration !== generation.current) return;
      if (!result.ok) {
        requestedOffsets.current.delete(offset);
        setError(publicError(result.error));
        return;
      }
      const chunk = result.value;
      if (chunk.id !== detail.id || chunk.detailIndex !== detail.detailIndex) {
        requestedOffsets.current.delete(offset);
        setError(invalidChunkError());
        return;
      }
      if (chunk.status === "unavailable") {
        nextOffsetRef.current = undefined;
        setNextOffset(undefined);
        setUnavailableReason(chunk.reason);
        return;
      }
      const returnedCharacters = codePointCount(chunk.text);
      const expectedNextOffset = offset + returnedCharacters;
      const validRange = chunk.offset === offset && chunk.returnedCharacters === returnedCharacters &&
        expectedNextOffset <= chunk.totalCharacters &&
        (chunk.nextOffset === undefined
          ? expectedNextOffset === chunk.totalCharacters
          : chunk.nextOffset === expectedNextOffset);
      if (!validRange) {
        requestedOffsets.current.delete(offset);
        setError(invalidChunkError());
        return;
      }
      setText((current) => `${current}${chunk.text}`);
      setLoadedCharacters(chunk.nextOffset ?? chunk.totalCharacters);
      setTotalCharacters(chunk.totalCharacters);
      nextOffsetRef.current = chunk.nextOffset;
      setNextOffset(chunk.nextOffset);
    } catch {
      requestedOffsets.current.delete(offset);
      if (requestGeneration === generation.current) {
        setError({
          code: "renderer.technical_detail_failed",
          message: "无法加载下一段技术细节。",
          retryable: true,
        });
      }
    } finally {
      if (requestGeneration === generation.current) setBusy(false);
    }
  }, [api, detail.available, detail.detailIndex, detail.id, itemIndex, sessionRef]);

  const toggle = (): void => {
    const nextOpen = !open;
    setOpen(nextOpen);
    if (!nextOpen || expandedOnce.current) return;
    expandedOnce.current = true;
    if (detail.available && nextOffsetRef.current !== undefined) void loadNext();
  };

  const copy = async (): Promise<void> => {
    try {
      await writeClipboard(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <details open={open} className="technical-detail-view">
      <summary onClick={(event) => { event.preventDefault(); toggle(); }}>
        {detail.label}<span>{detail.summary}</span>
      </summary>
      <div className="technical-detail-content">
        {text === "" ? null : <pre>{text}</pre>}
        {unavailableReason === undefined ? null : (
          <div className="technical-detail-unavailable" role="status">{unavailableReason}</div>
        )}
        {error === undefined ? null : (
          <div className="technical-detail-error" role="alert">
            <TriangleAlert size={13} aria-hidden="true" />
            <span>{error.message}</span>
            {error.retryable ? <button type="button" onClick={() => void loadNext()}>重试</button> : null}
          </div>
        )}
        {detail.available && text !== "" ? (
          <div className="technical-detail-footer">
            <span>
              {nextOffset === undefined
                ? unavailableReason === undefined
                  ? `已完整加载 · ${formatCharacters(loadedCharacters)} 个字符`
                  : `预览 · 可用 ${formatCharacters(loadedCharacters)} 个字符`
                : `已加载 ${formatCharacters(loadedCharacters)} / ${formatCharacters(totalCharacters)} 个字符`}
            </span>
            <button type="button" aria-label="复制已加载的技术细节" onClick={() => void copy()}>
              {copyState === "copied" ? <Check size={13} /> : copyState === "failed" ? <TriangleAlert size={13} /> : <Clipboard size={13} />}
              {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制"}
            </button>
          </div>
        ) : null}
        {busy ? (
          <div className="technical-detail-loading" role="status"><LoaderCircle className="spin" size={13} />正在加载下一段…</div>
        ) : error === undefined && nextOffset !== undefined ? (
          <button className="technical-detail-more" type="button" onClick={() => void loadNext()}>加载更多</button>
        ) : null}
      </div>
    </details>
  );
}

function codePointCount(value: string): number {
  return Array.from(value).length;
}

function formatCharacters(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function publicError(error: DesktopError): DesktopError {
  return { code: error.code, message: error.message, retryable: error.retryable };
}

function invalidChunkError(): DesktopError {
  return {
    code: "renderer.technical_detail_invalid_chunk",
    message: "无法验证下一段技术细节。",
    retryable: true,
  };
}
