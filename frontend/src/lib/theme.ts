export const themes = [
  { id: "nocturne", name: "Nocturne", description: "Soft violet on midnight" },
  { id: "carbon", name: "Carbon", description: "Ink black with mint light" },
  { id: "grove", name: "Grove", description: "Deep green and warm gold" },
  { id: "paper", name: "Paper", description: "Warm, quiet daylight" },
] as const;

export type ThemeId = (typeof themes)[number]["id"];

const STORAGE_KEY = "pi-everywhere-theme";
const ids = new Set<ThemeId>(themes.map((theme) => theme.id));

function isThemeId(value: string | null): value is ThemeId {
  return value !== null && ids.has(value as ThemeId);
}

export function storedTheme(): ThemeId {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (isThemeId(value)) return value;
  } catch {
    // Private browsing and locked-down webviews may reject storage access.
  }
  const preloaded = document.documentElement.dataset.theme ?? null;
  return isThemeId(preloaded) ? preloaded : "nocturne";
}

export function applyTheme(theme: ThemeId, persist = true): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === "paper" ? "light" : "dark";
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
    "content",
    theme === "paper" ? "#f3efe6" : theme === "carbon" ? "#0a0d0e" : theme === "grove" ? "#09130f" : "#11111b",
  );
  if (!persist) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // The visual choice still applies for this page when storage is unavailable.
  }
}

export function initializeTheme(): ThemeId {
  const theme = storedTheme();
  applyTheme(theme, false);
  return theme;
}
