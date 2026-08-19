"use strict";

const FLOATING_WINDOW_WIDTH = 360;
const FLOATING_WINDOW_MIN_HEIGHT = 188;
const FLOATING_WINDOW_FALLBACK_MAX_HEIGHT = 460;
const FLOATING_WINDOW_MAX_HEIGHT_RATIO = 0.7;
const FLOATING_WINDOW_LAYOUT_INTERVAL = 1000;
const FLOATING_WINDOW_RADIUS = 22;

const FLOATING_MEASURE_SCRIPT = `(() => {
  const shell = document.querySelector(".floating-shell");
  if (!shell) {
    return null;
  }

  const visibleChildren = (element) =>
    Array.from(element.children).filter((child) => window.getComputedStyle(child).display !== "none");
  const boxMetrics = (element) => {
    const style = window.getComputedStyle(element);
    const gap = Number.parseFloat(style.rowGap || style.gap) || 0;
    const padding =
      (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const border =
      (Number.parseFloat(style.borderTopWidth) || 0) +
      (Number.parseFloat(style.borderBottomWidth) || 0);
    return { gap, padding, border };
  };
  const naturalStackHeight = (element) => {
    const children = visibleChildren(element);
    const { gap, padding, border } = boxMetrics(element);
    const childHeight = children.reduce(
      (total, child) => total + child.getBoundingClientRect().height,
      0
    );
    return border + padding + childHeight + gap * Math.max(0, children.length - 1);
  };

  const shellChildren = visibleChildren(shell);
  const { gap, padding, border } = boxMetrics(shell);
  const contentHeight = shellChildren.reduce((total, child) => {
    const isFlexibleStack =
      child.classList.contains("floating-list") || child.classList.contains("floating-empty");
    return total + (isFlexibleStack ? naturalStackHeight(child) : child.getBoundingClientRect().height);
  }, 0);
  const screenInfo = window.screen || {};

  return {
    contentHeight: Math.ceil(border + padding + contentHeight + gap * Math.max(0, shellChildren.length - 1)),
    availableHeight: Number(screenInfo.availHeight),
    availableTop: Number(screenInfo.availTop)
  };
})()`;

const FLOATING_SYNC_SCRIPT = `(async () => {
  for (let attempt = 0; attempt < 20 && typeof window.__quotaSyncProviders !== "function"; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 25));
  }
  if (typeof window.__quotaSyncProviders === "function") {
    await window.__quotaSyncProviders();
  }
  await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
  return ${FLOATING_MEASURE_SCRIPT};
})()`;

function createFloatingWindowController(utoolsApi, options) {
  const settings = options || {};
  let floatingWindow = null;
  let floatingLayoutTask = null;
  let floatingLayoutTimer = null;

  function createRoundedWindowShape(width, height) {
    const radius = Math.min(FLOATING_WINDOW_RADIUS, Math.floor(width / 2), Math.floor(height / 2));
    const shape = [
      {
        x: 0,
        y: radius,
        width,
        height: Math.max(0, height - radius * 2)
      }
    ];

    for (let y = 0; y < radius; y += 1) {
      const distanceFromCenter = radius - y - 0.5;
      const inset = Math.ceil(radius - Math.sqrt(radius * radius - distanceFromCenter * distanceFromCenter));
      const rowWidth = Math.max(0, width - inset * 2);
      shape.push({ x: inset, y, width: rowWidth, height: 1 });
      shape.push({ x: inset, y: height - y - 1, width: rowWidth, height: 1 });
    }

    return shape;
  }

  function applyFloatingWindowShape(targetWindow, width, height) {
    if (!targetWindow || typeof targetWindow.setShape !== "function") {
      return false;
    }

    try {
      targetWindow.setShape(createRoundedWindowShape(width, height));
      return true;
    } catch (error) {
      console.warn("[quota-dock] 系统窗口圆角不可用，已使用 CSS 圆角降级", error);
      return false;
    }
  }

  function applyFloatingWindowSurface(targetWindow, width, height) {
    if (!targetWindow) {
      return;
    }

    try {
      if (typeof targetWindow.setBackgroundColor === "function") {
        targetWindow.setBackgroundColor("#00000000");
      }
      if (typeof targetWindow.setHasShadow === "function") {
        targetWindow.setHasShadow(false);
      }
      applyFloatingWindowShape(targetWindow, width, height);
    } catch (error) {
      console.warn("[quota-dock] 浮窗透明圆角设置失败，已使用 CSS 圆角降级", error);
    }
  }

  function stopLayoutMonitor() {
    if (floatingLayoutTimer) {
      clearInterval(floatingLayoutTimer);
      floatingLayoutTimer = null;
    }
  }

  function isOpen() {
    if (!floatingWindow) {
      return false;
    }

    try {
      return typeof floatingWindow.isDestroyed !== "function" || !floatingWindow.isDestroyed();
    } catch {
      return false;
    }
  }

  function resize(layout) {
    if (!floatingWindow || !layout) {
      return false;
    }

    const contentHeight = Number(layout.contentHeight);
    if (!Number.isFinite(contentHeight) || contentHeight <= 0) {
      return false;
    }

    const availableHeight = Number(layout.availableHeight);
    const availableTop = Number(layout.availableTop);
    const maxHeight = Number.isFinite(availableHeight) && availableHeight > 0
      ? Math.max(FLOATING_WINDOW_MIN_HEIGHT, Math.floor(availableHeight * FLOATING_WINDOW_MAX_HEIGHT_RATIO))
      : FLOATING_WINDOW_FALLBACK_MAX_HEIGHT;
    const targetHeight = Math.min(
      maxHeight,
      Math.max(FLOATING_WINDOW_MIN_HEIGHT, Math.ceil(contentHeight))
    );

    try {
      if (typeof floatingWindow.isDestroyed === "function" && floatingWindow.isDestroyed()) {
        return false;
      }

      const hasBoundsApi =
        typeof floatingWindow.getBounds === "function" && typeof floatingWindow.setBounds === "function";
      const currentBounds = hasBoundsApi ? floatingWindow.getBounds() : null;
      const nextBounds = currentBounds
        ? { ...currentBounds, width: FLOATING_WINDOW_WIDTH, height: targetHeight }
        : null;

      if (nextBounds && Number.isFinite(availableTop) && Number.isFinite(availableHeight) && availableHeight > 0) {
        const workAreaBottom = availableTop + availableHeight;
        nextBounds.y = Math.min(
          Math.max(nextBounds.y, availableTop),
          Math.max(availableTop, workAreaBottom - targetHeight)
        );
      }

      let changed = false;
      if (nextBounds) {
        changed =
          nextBounds.width !== currentBounds.width ||
          nextBounds.height !== currentBounds.height ||
          nextBounds.y !== currentBounds.y;
        if (changed) {
          floatingWindow.setBounds(nextBounds);
        }
      } else if (typeof floatingWindow.setSize === "function") {
        const actualSize = typeof floatingWindow.getSize === "function" ? floatingWindow.getSize() : null;
        changed =
          !Array.isArray(actualSize) ||
          actualSize[0] !== FLOATING_WINDOW_WIDTH ||
          actualSize[1] !== targetHeight;
        if (changed) {
          floatingWindow.setSize(FLOATING_WINDOW_WIDTH, targetHeight);
        }
      } else {
        return false;
      }

      if (changed) {
        applyFloatingWindowShape(floatingWindow, FLOATING_WINDOW_WIDTH, targetHeight);
      }
      return true;
    } catch (error) {
      console.warn("[quota-dock] 同步浮窗高度失败", error);
      return false;
    }
  }

  async function updateLayout(script) {
    if (floatingLayoutTask) {
      await floatingLayoutTask.catch(() => null);
    }

    const task = (async () => {
      if (
        !floatingWindow ||
        (typeof floatingWindow.isDestroyed === "function" && floatingWindow.isDestroyed()) ||
        !floatingWindow.webContents ||
        typeof floatingWindow.webContents.executeJavaScript !== "function"
      ) {
        return null;
      }

      try {
        const layout = await floatingWindow.webContents.executeJavaScript(script);
        resize(layout);
        return layout;
      } catch (error) {
        console.warn("[quota-dock] 读取浮窗布局失败", error);
        return null;
      }
    })();

    floatingLayoutTask = task;
    try {
      return await task;
    } finally {
      if (floatingLayoutTask === task) {
        floatingLayoutTask = null;
      }
    }
  }

  function startLayoutMonitor() {
    stopLayoutMonitor();
    floatingLayoutTimer = setInterval(() => {
      if (!floatingLayoutTask) {
        void updateLayout(FLOATING_MEASURE_SCRIPT);
      }
    }, FLOATING_WINDOW_LAYOUT_INTERVAL);
    if (floatingLayoutTimer && typeof floatingLayoutTimer.unref === "function") {
      floatingLayoutTimer.unref();
    }
  }

  async function sync() {
    if (!isOpen()) {
      return;
    }
    await updateLayout(FLOATING_SYNC_SCRIPT);
  }

  async function open() {
    if (!utoolsApi || typeof utoolsApi.createBrowserWindow !== "function") {
      throw new Error("当前 uTools 环境不支持创建浮窗");
    }

    if (isOpen()) {
      await sync();
      startLayoutMonitor();
      floatingWindow.show?.();
      floatingWindow.focus?.();
      return true;
    }

    floatingWindow = null;
    let createdWindow = null;
    createdWindow = utoolsApi.createBrowserWindow(
      "floating.html",
      {
        width: FLOATING_WINDOW_WIDTH,
        height: FLOATING_WINDOW_MIN_HEIGHT,
        title: "AI 额度浮窗",
        frame: false,
        resizable: false,
        closeable: true,
        minimizable: false,
        maximizable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        autoHideMenuBar: true,
        show: false,
        transparent: true,
        hasShadow: false,
        roundedCorners: false,
        backgroundColor: "#00000000",
        webPreferences: {
          preload: settings.preloadPath
        }
      },
      async () => {
        if (!createdWindow || floatingWindow !== createdWindow || !isOpen()) {
          return;
        }
        applyFloatingWindowSurface(createdWindow, FLOATING_WINDOW_WIDTH, FLOATING_WINDOW_MIN_HEIGHT);
        await sync();
        startLayoutMonitor();
        if (floatingWindow === createdWindow) {
          createdWindow.show?.();
          createdWindow.setAlwaysOnTop?.(true, "floating");
        }
      }
    );
    floatingWindow = createdWindow;

    createdWindow?.on?.("closed", () => {
      if (floatingWindow === createdWindow) {
        stopLayoutMonitor();
        floatingLayoutTask = null;
        floatingWindow = null;
      }
    });
    return true;
  }

  async function close() {
    stopLayoutMonitor();

    if (!isOpen()) {
      floatingWindow = null;
      floatingLayoutTask = null;
      return true;
    }

    const targetWindow = floatingWindow;
    floatingWindow = null;
    floatingLayoutTask = null;

    if (typeof targetWindow.close === "function") {
      await Promise.resolve(targetWindow.close());
    } else if (typeof targetWindow.destroy === "function") {
      await Promise.resolve(targetWindow.destroy());
    }
    return true;
  }

  return {
    isOpen,
    open,
    close,
    sync
  };
}

module.exports = {
  FLOATING_WINDOW_WIDTH,
  FLOATING_WINDOW_MIN_HEIGHT,
  FLOATING_MEASURE_SCRIPT,
  FLOATING_SYNC_SCRIPT,
  createFloatingWindowController
};
