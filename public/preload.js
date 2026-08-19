"use strict";

(function initQuotaPreload() {
  const root = typeof window !== "undefined" ? window : globalThis;

  function exposePreloadError(error) {
    const message = error && error.message ? error.message : String(error || "未知 preload 错误");
    root.__quotaPreloadError = {
      message,
      stack: error && error.stack ? error.stack : ""
    };

    if (typeof console !== "undefined" && console.error) {
      console.error("[quota-dock] preload 初始化失败", error);
    }
  }

  function isFloatingEntry() {
    const location = root && root.location;
    const pathname = String((location && location.pathname) || "").replace(/\\/g, "/");
    return /(?:^|\/)floating\.html$/i.test(pathname);
  }

  try {
    const path = require("path");
    const { createFloatingWindowController } = require("./libs/floating-window-controller.js");
    const { requestJson } = require("./libs/http-json-client.js");
    const { createMcpHandlers, registerMcpHandlers } = require("./libs/mcp-handlers.js");
    const { createQuotaService } = require("./libs/quota-service.js");
    const utoolsApi = typeof utools !== "undefined" ? utools : root.utools;
    const floatingController = createFloatingWindowController(utoolsApi, {
      preloadPath: path.join(__dirname, "preload.js")
    });
    const quotaService = createQuotaService({
      utools: utoolsApi,
      requestJson,
      onProvidersChanged: () => floatingController.sync()
    });

    root.quotaBridge = {
      getSyncState: quotaService.getSyncState,
      listProviderTemplates: quotaService.listProviderTemplates,
      listOfficialProviderPresets: quotaService.listOfficialProviderPresets,
      listProviders: quotaService.listProviders,
      saveProvider: quotaService.saveProvider,
      setProviderFloatingVisibility: quotaService.setProviderFloatingVisibility,
      testProviderRequest: quotaService.testProviderRequest,
      testOfficialProvider: quotaService.testOfficialProvider,
      deleteProvider: quotaService.deleteProvider,
      refreshProvider: quotaService.refreshProvider,
      refreshDueProviders: quotaService.refreshDueProviders,
      refreshAll: quotaService.refreshAll,
      openFloatingWindow: floatingController.open
    };

    if (!isFloatingEntry()) {
      registerMcpHandlers(
        utoolsApi,
        createMcpHandlers({ quotaService, floatingController })
      );
    }

    root.__quotaPreloadReady = true;
    root.__quotaPreloadError = null;
  } catch (error) {
    exposePreloadError(error);
  }
})();
