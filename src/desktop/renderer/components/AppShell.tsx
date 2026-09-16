import { MessagesSquare, Settings, Sparkles } from "lucide-react";
import type { ReactNode } from "react";

import { classes } from "../lib/display.js";

export type PrimaryPage = "chats" | "experience" | "settings";

const NAVIGATION = [
  { id: "chats", label: "对话", icon: MessagesSquare },
  { id: "experience", label: "经验", icon: Sparkles },
  { id: "settings", label: "设置", icon: Settings },
] as const;

interface AppShellProps {
  readonly page: PrimaryPage;
  readonly version: string;
  readonly children: ReactNode;
  readonly onNavigate: (page: PrimaryPage) => void;
}

export function AppShell({ page, version, children, onNavigate }: AppShellProps) {
  return (
    <div className="app-shell">
      <aside className="primary-sidebar" aria-label="主导航">
        <div className="app-mark" aria-label="AgentHist">AH</div>
        <nav className="primary-nav">
          {NAVIGATION.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={classes("nav-item", page === item.id && "is-active")}
                type="button"
                key={item.id}
                aria-current={page === item.id ? "page" : undefined}
                onClick={() => onNavigate(item.id)}
              >
                <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <span className="sidebar-version">v{version}</span>
      </aside>
      <main className="app-content">{children}</main>
    </div>
  );
}
