import { Check, Clipboard, TriangleAlert } from "lucide-react";
import {
  Children,
  isValidElement,
  memo,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownMessageProps {
  readonly text: string;
  readonly writeClipboard: ClipboardWriter | undefined;
}

export type ClipboardWriter = (text: string) => Promise<void>;

const browserClipboardWriter: ClipboardWriter = async (text) => {
  await navigator.clipboard.writeText(text);
};

export const MarkdownMessage = memo(function MarkdownMessage({
  text,
  writeClipboard = browserClipboardWriter,
}: MarkdownMessageProps) {
  const components = useMemo<Components>(() => ({
    a: ({ children, href }) => {
      const safe = safeLink(href);
      return safe === undefined
        ? <span className="unsafe-link">{children}</span>
        : <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a>;
    },
    img: ({ alt }) => <span className="markdown-image-placeholder">[图片{alt ? `：${alt}` : ""}]</span>,
    pre: ({ children }) => <MarkdownCodeBlock writeClipboard={writeClipboard}>{children}</MarkdownCodeBlock>,
    code: ({ children, className, ...properties }) => (
      <code className={className} {...properties}>{children}</code>
    ),
  }), [writeClipboard]);

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

function safeLink(href: string | undefined): string | undefined {
  if (href === undefined) return undefined;
  if (href.startsWith("#")) return href;
  try {
    const parsed = new URL(href);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === ""
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

function MarkdownCodeBlock({ children, writeClipboard }: {
  readonly children: ReactNode;
  readonly writeClipboard: ClipboardWriter;
}) {
  const child = Children.toArray(children)[0];
  const properties = isValidElement<{ readonly children?: ReactNode; readonly className?: string }>(child)
    ? child.props
    : undefined;
  const code = nodeText(properties?.children ?? child).replace(/\n$/, "");
  const language = properties?.className?.replace(/^language-/, "") ?? "code";
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (copyState === "idle") return;
    const timeout = window.setTimeout(() => setCopyState("idle"), 1_500);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  const copy = async (): Promise<void> => {
    try {
      await writeClipboard(code);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <div className="code-block">
      <div className="code-block-toolbar">
        <span>{language}</span>
        <button type="button" onClick={() => void copy()} aria-label="复制代码">
          {copyState === "copied" ? <Check size={14} /> : copyState === "failed" ? <TriangleAlert size={14} /> : <Clipboard size={14} />}
          {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制"}
        </button>
      </div>
      <pre><code className={properties?.className}>{code}</code></pre>
    </div>
  );
}

function nodeText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(nodeText).join("");
  if (isValidElement<{ readonly children?: ReactNode }>(value)) return nodeText(value.props.children);
  return "";
}
