import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatList } from "../../src/desktop/renderer/components/ChatList.js";
import { buildChatTree, flattenChatTree } from "../../src/desktop/renderer/lib/chat-tree.js";
import { chat } from "./fixtures.js";

describe("Directory tree", () => {
  const codex = chat(1, "codex", { workspace: "\\\\?\\D:\\demo-project", workspaceName: "demo-project" });
  const claude = chat(2, "claude", { workspace: "d:/DEMO-PROJECT/", workspaceName: "DEMO-PROJECT" });
  const nested = chat(3, "pi", { workspace: "D:\\demo-project\\nested" });
  const elsewhere = chat(4, "codex", { workspace: "C:\\Work\\demo-project" });

  it("builds unique disks and directories with mixed agents and distinct full paths", () => {
    const roots = buildChatTree([codex, claude, nested, elsewhere, codex]);
    expect(roots.map((folder) => folder.name)).toEqual(["C:", "D:"]);
    const project = roots[1]!.children[0]!;
    expect(project.name).toBe("demo-project");
    expect(project.chats).toEqual([codex, claude]);
    expect(project.descendants).toHaveLength(3);
    expect(project.children[0]!.name).toBe("nested");
    expect(flattenChatTree(roots, new Set([roots[1]!.key])).filter((row) => row.type === "chat")).toHaveLength(1);
    const posix = buildChatTree([chat(5, "codex", { workspace: "/work/Project" }), chat(6, "pi", { workspace: "/work/project" })]);
    expect(posix[0]!.children[0]!.children).toHaveLength(2);
  });

  it("collapses disk subtrees and selects all agents beneath a folder", async () => {
    const onSelect = vi.fn();
    const onToggleWorkspaceSelection = vi.fn();
    render(<ChatList chats={[codex, claude, nested]} total={3} selectedSessionRef={codex.sessionRef}
      selectedSessionRefs={new Set()} selectionBusy={new Set()} selectionEnabled loadingMore={false}
      emptyTitle="Empty" emptyDescription="Empty" onLoadMore={vi.fn()} onSelect={onSelect}
      onToggleChatSelection={vi.fn()} onToggleWorkspaceSelection={onToggleWorkspaceSelection} />);
    const user = userEvent.setup();
    const tree = screen.getByRole("tree", { name: "按目录浏览对话" });
    expect(within(tree).getAllByRole("button", { name: "折叠demo-project" })).toHaveLength(1);
    expect(within(tree).queryByRole("button", { name: "折叠Codex" })).not.toBeInTheDocument();
    await user.click(within(tree).getByText(claude.title));
    expect(onSelect).toHaveBeenCalledWith(claude);
    await user.click(screen.getByRole("checkbox", { name: "选择demo-project中的全部对话" }));
    expect(onToggleWorkspaceSelection).toHaveBeenCalledWith("D:\\demo-project", undefined, [codex, claude, nested], true);
    await user.click(screen.getByRole("button", { name: "折叠D:" }));
    expect(within(tree).queryByText(codex.title)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开D:" }));
    expect(within(tree).getByText(codex.title)).toBeInTheDocument();
  });
});
