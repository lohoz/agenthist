import { useEffect } from "react";

import type { DesktopTheme } from "../../contracts.js";

function resolvedTheme(theme: DesktopTheme, media: MediaQueryList): "light" | "dark" {
  return theme === "system" ? (media.matches ? "dark" : "light") : theme;
}

export function useTheme(theme: DesktopTheme): void {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      document.documentElement.dataset.theme = resolvedTheme(theme, media);
      document.documentElement.dataset.themePreference = theme;
    };
    apply();
    if (theme !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
}
