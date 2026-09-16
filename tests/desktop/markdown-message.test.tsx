import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MarkdownMessage } from "../../src/desktop/renderer/components/MarkdownMessage.js";

describe("Markdown message stability", () => {
  it("preserves copy feedback and payload across a same-message parent rerender", async () => {
    const writeClipboard = vi.fn(async (_text: string): Promise<void> => {});
    const text = "```ts\nconst stable = true;\n```";
    const user = userEvent.setup();
    const view = render(<Parent revision={0} text={text} writeClipboard={writeClipboard} />);

    await user.click(screen.getByRole("button", { name: "复制代码" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "复制代码" })).toHaveTextContent("已复制"));
    view.rerender(<Parent revision={1} text={text} writeClipboard={writeClipboard} />);

    expect(screen.getByRole("button", { name: "复制代码" })).toHaveTextContent("已复制");
    expect(writeClipboard).toHaveBeenCalledTimes(1);
    expect(writeClipboard).toHaveBeenCalledWith("const stable = true;");
  });

  it("renders only HTTPS and fragment links as anchors and never loads Markdown images", () => {
    render(
      <MarkdownMessage
        text={[
          "[Secure](https://example.com/path)",
          "[Fragment](#section)",
          "[Plain HTTP](http://example.com/track)",
          "[File](file:///C:/private.txt)",
          "[Custom](agenthist://private)",
          "[Credentials](https://user:secret@example.com/path)",
          "![Tracker](https://example.com/pixel.png)",
        ].join("\n\n")}
        writeClipboard={async () => {}}
      />,
    );

    expect(screen.getByRole("link", { name: "Secure" })).toHaveAttribute("href", "https://example.com/path");
    expect(screen.getByRole("link", { name: "Fragment" })).toHaveAttribute("href", "#section");
    for (const label of ["Plain HTTP", "File", "Custom", "Credentials"]) {
      expect(screen.getByText(label)).toHaveClass("unsafe-link");
      expect(screen.queryByRole("link", { name: label })).not.toBeInTheDocument();
    }
    expect(screen.getByText("[图片：Tracker]")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });
});

function Parent({ revision, text, writeClipboard }: {
  readonly revision: number;
  readonly text: string;
  readonly writeClipboard: (text: string) => Promise<void>;
}) {
  return (
    <div data-revision={revision}>
      <MarkdownMessage text={text} writeClipboard={writeClipboard} />
    </div>
  );
}
