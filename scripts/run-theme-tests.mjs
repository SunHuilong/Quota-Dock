import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync("src/shared/theme.ts", "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  }
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
    if (type === "change") {
      mediaListeners.add(listener);
    }
  }
};
const documentElement = { dataset: {}, style: {} };
const windowMock = {
  matchMedia() {
    return mediaQuery;
  },
  localStorage: {
    getItem(key) {
      return storedValues.get(key) ?? null;
    },
    setItem(key, value) {
      storedValues.set(key, value);
    }
  },
  addEventListener(type, listener) {
    if (type === "storage") {
      storageListeners.add(listener);
    }
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
assert.equal(documentElement.dataset.themeMode, "system");

systemDark = true;
for (const listener of mediaListeners) {
  listener({ matches: true });
}
assert.equal(documentElement.dataset.theme, "dark");

theme.setThemeMode("light");
assert.equal(documentElement.dataset.theme, "light");
assert.equal(storedValues.get("quota-dock/theme-mode"), "light");

systemDark = false;
for (const listener of mediaListeners) {
  listener({ matches: false });
}
assert.equal(documentElement.dataset.theme, "light");

theme.setThemeMode("dark");
assert.equal(documentElement.dataset.theme, "dark");

for (const listener of storageListeners) {
  listener({ key: "quota-dock/theme-mode", newValue: "system" });
}
assert.equal(theme.getThemeMode(), "system");
assert.equal(documentElement.dataset.theme, "light");

for (const listener of storageListeners) {
  listener({ key: "quota-dock/theme-mode", newValue: "dark" });
}
assert.equal(theme.getThemeMode(), "dark");
assert.equal(documentElement.dataset.theme, "dark");

console.log("Theme mode default, switching, system response, and storage synchronization tests passed");
