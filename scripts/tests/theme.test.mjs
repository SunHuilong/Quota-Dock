import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

test("theme defaults, switching, system changes, and storage synchronization", () => {
  const source = readFileSync("src/shared/theme.ts", "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  let systemDark = false;
  const mediaListeners = new Set();
  const storageListeners = new Set();
  const storedValues = new Map();
  const mediaQuery = {
    get matches() {
      return systemDark;
    },
    addEventListener(type, listener) {
      if (type === "change") mediaListeners.add(listener);
    }
  };
  const documentElement = { dataset: {}, style: {} };
  const windowMock = {
    matchMedia: () => mediaQuery,
    localStorage: {
      getItem: (key) => storedValues.get(key) ?? null,
      setItem: (key, value) => storedValues.set(key, value)
    },
    addEventListener(type, listener) {
      if (type === "storage") storageListeners.add(listener);
    }
  };
  const moduleMock = { exports: {} };
  vm.runInNewContext(output, {
    module: moduleMock,
    exports: moduleMock.exports,
    window: windowMock,
    document: { documentElement },
    console
  });
  const theme = moduleMock.exports;

  theme.initializeTheme();
  assert.equal(theme.getThemeMode(), "system");
  assert.equal(documentElement.dataset.theme, "light");
  systemDark = true;
  for (const listener of mediaListeners) listener({ matches: true });
  assert.equal(documentElement.dataset.theme, "dark");
  theme.setThemeMode("light");
  assert.equal(storedValues.get("quota-dock/theme-mode"), "light");
  systemDark = false;
  for (const listener of mediaListeners) listener({ matches: false });
  assert.equal(documentElement.dataset.theme, "light");
  for (const listener of storageListeners) listener({ key: "quota-dock/theme-mode", newValue: "dark" });
  assert.equal(theme.getThemeMode(), "dark");
  assert.equal(documentElement.dataset.theme, "dark");
});

test("floating entry loads only shared and floating styles", () => {
  const entry = readFileSync("src/styles/floating-entry.css", "utf8");
  assert.match(entry, /base\.css/);
  assert.match(entry, /floating\.css/);
  assert.doesNotMatch(entry, /dashboard\.css|editor\.css|app\.css/);

  const floatingBundleSource = ["base.css", "floating.css", "accessibility.css"]
    .map((file) => readFileSync(`src/styles/${file}`, "utf8"))
    .join("\n");
  for (const selector of [".top-bar", ".provider-list", ".provider-modal", ".path-map", ".theme-menu"]) {
    assert.equal(floatingBundleSource.includes(selector), false, selector);
  }
});

test("visual fixtures retain all requested layout scenarios and themes", () => {
  const fixture = readFileSync("src/shared/visual-fixture.ts", "utf8");
  for (const scenario of ["default", "empty", "error", "loading", "one", "two"]) {
    assert.match(fixture, new RegExp(`\\b${scenario}\\b`), scenario);
  }
  assert.match(fixture, /visual-theme/);
  assert.match(fixture, /visual-contrast/);
  assert.match(fixture, /visual-motion/);
  assert.match(readFileSync("src/styles/visual-fixture.css", "utf8"), /data-visual-theme/);
});
