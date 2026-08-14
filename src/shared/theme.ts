export type ThemeMode = "system" | "light" | "dark";

const THEME_STORAGE_KEY = "quota-dock/theme-mode";
const systemDarkMode = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<(mode: ThemeMode) => void>();

let themeMode = readStoredThemeMode();
let initialized = false;

function normalizeThemeMode(value: string | null): ThemeMode {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

function readStoredThemeMode(): ThemeMode {
  try {
    return normalizeThemeMode(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function effectiveTheme(mode: ThemeMode) {
  return mode === "system" ? (systemDarkMode.matches ? "dark" : "light") : mode;
}

function applyTheme() {
  const theme = effectiveTheme(themeMode);
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themeMode = themeMode;
  document.documentElement.style.colorScheme = theme;
}

function notifyThemeMode() {
  for (const listener of listeners) {
    listener(themeMode);
  }
}

function handleSystemThemeChange() {
  if (themeMode === "system") {
    applyTheme();
  }
}

function handleThemeStorage(event: StorageEvent) {
  if (event.key !== THEME_STORAGE_KEY) {
    return;
  }

  const nextMode = normalizeThemeMode(event.newValue);
  if (nextMode === themeMode) {
    return;
  }

  themeMode = nextMode;
  applyTheme();
  notifyThemeMode();
}

export function initializeTheme() {
  applyTheme();

  if (initialized) {
    return;
  }

  initialized = true;
  systemDarkMode.addEventListener("change", handleSystemThemeChange);
  window.addEventListener("storage", handleThemeStorage);
}

export function getThemeMode() {
  return themeMode;
}

export function setThemeMode(nextMode: ThemeMode) {
  if (nextMode === themeMode) {
    applyTheme();
    return;
  }

  themeMode = nextMode;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, nextMode);
  } catch {
    // The current window still receives the selected theme when storage is unavailable.
  }
  applyTheme();
  notifyThemeMode();
}

export function subscribeThemeMode(listener: (mode: ThemeMode) => void) {
  listeners.add(listener);
  listener(themeMode);
  return () => listeners.delete(listener);
}
