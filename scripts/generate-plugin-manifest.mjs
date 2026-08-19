import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  nonNegativeInteger,
  nullableString,
  strictObject,
  withSchemaDefs
} from "./mcp-schema-fragments.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
const manifestPath = resolve(rootDir, "public/plugin.json");
const providerId = { type: "string", minLength: 1, maxLength: 256 };
const scope = { type: "string", enum: ["due", "all", "selected"] };
const category = { type: "string", enum: ["api", "plan", "admin"] };

const overviewOutput = withSchemaDefs(
  strictObject({
    generatedAt: { type: "string" },
    providerCount: nonNegativeInteger,
    configuredCount: nonNegativeInteger,
    statusCounts: { $ref: "#/$defs/statusCounts" },
    totalsByUnit: { type: "array", items: { $ref: "#/$defs/unitTotal" } },
    providers: { type: "array", items: { $ref: "#/$defs/providerSummary" } },
    refresh: { $ref: "#/$defs/refreshBatch" }
  }),
  ["statusCounts", "unitTotal", "providerSummary", "refreshBatch"]
);

const refreshOutput = withSchemaDefs(
  strictObject({
    generatedAt: { type: "string" },
    scope,
    requestedCount: nonNegativeInteger,
    successCount: nonNegativeInteger,
    failureCount: nonNegativeInteger,
    results: { type: "array", items: { $ref: "#/$defs/refreshOutcome" } }
  }),
  ["refreshOutcome"]
);

const platform = strictObject({
  id: { type: "string" },
  name: { type: "string" },
  category,
  categoryLabel: { type: "string" },
  credentialLabel: { type: "string" },
  credentialHelp: { type: "string" },
  defaultUnit: { type: "string" },
  supportsManualLimit: { type: "boolean" },
  supportsCurrencyOverride: { type: "boolean" }
});

const manifest = {
  pluginName: "Quota Dock - AI额度看板",
  description:
    "Quota Dock 用于集中查询和监控 AI API 平台的账户余额与套餐额度。\n\n支持平台\nDeepSeek\nKimi\n阶跃星辰 StepFun\n硅基流动 SiliconFlow\n302.AI\nNovita AI\nOpenRouter\nMiniMax Token Plan\n智谱 GLM Coding Plan\nZ.AI Coding Plan\nxAI / Grok\nOpenAI Organization\nAnthropic Organization\nAIHubMix\n\n支持查询\n账户余额\n总额度与已用额度\nCoding Plan 套餐额度\n额度重置时间\n多货币余额汇总\n\n主要功能\n集中管理官方平台与中转站\n支持自定义 Base URL、API Key、请求参数和 JSON 字段映射\n自动刷新余额与额度\n桌面浮窗实时监控\n通过 uTools MCP 向 AI Agent 提供安全的额度查询、健康检查和浮窗控制能力",
  author: "Codex",
  homepage: "",
  version: packageJson.version,
  logo: "logo.png",
  main: "index.html",
  preload: "preload.js",
  pluginSetting: { height: 520 },
  tools: {
    quota_overview: {
      description: "刷新全部已配置站点，并返回不含凭证和请求配置的额度总览、状态统计及按币种汇总。单个站点失败不会中断其他站点。",
      inputSchema: strictObject({}, []),
      outputSchema: overviewOutput
    },
    quota_provider_detail: {
      description: "刷新指定站点并返回该站点的全部额度项。返回值经过脱敏，不包含 API Key、URL、请求配置或原始上游响应。",
      inputSchema: strictObject({ providerId }, ["providerId"]),
      outputSchema: withSchemaDefs(
        strictObject({
          generatedAt: { type: "string" },
          refresh: { $ref: "#/$defs/refreshBatch" },
          provider: { $ref: "#/$defs/providerDetail" }
        }),
        ["refreshBatch", "providerDetail"]
      )
    },
    quota_refresh: {
      description: "按 due、all 或 selected 范围刷新站点额度。selected 必须提供有效且不重复的 providerIds；返回逐站点成功或失败结果。",
      inputSchema: strictObject(
        {
          scope,
          providerIds: { type: "array", minItems: 1, maxItems: 100, items: providerId }
        },
        ["scope"]
      ),
      outputSchema: refreshOutput
    },
    quota_health_check: {
      description: "刷新全部站点并检查缺少凭证、预设不可用、刷新失败、未查询、数据过期和低剩余比例。默认阈值为 20% 与 60 分钟。",
      inputSchema: strictObject(
        {
          remainingPercentBelow: { type: "number", minimum: 0, maximum: 100 },
          staleAfterMinutes: { type: "number", exclusiveMinimum: 0, maximum: 525600 }
        },
        []
      ),
      outputSchema: withSchemaDefs(
        strictObject({
          generatedAt: { type: "string" },
          thresholds: { $ref: "#/$defs/thresholds" },
          healthy: { type: "boolean" },
          issueCount: nonNegativeInteger,
          issues: { type: "array", items: { $ref: "#/$defs/healthIssue" } },
          providers: { type: "array", items: { $ref: "#/$defs/providerSummary" } },
          refresh: { $ref: "#/$defs/refreshBatch" }
        }),
        ["thresholds", "healthIssue", "providerSummary", "refreshBatch"]
      )
    },
    quota_supported_platforms: {
      description: "返回 Quota Dock 内置的官方预设平台及其安全摘要，可按类别筛选。此工具不读取凭证，也不会发起网络请求。",
      inputSchema: strictObject({ category }, []),
      outputSchema: strictObject({
        generatedAt: { type: "string" },
        category: { ...nullableString, enum: [null, "api", "plan", "admin"] },
        platformCount: nonNegativeInteger,
        platforms: { type: "array", items: platform }
      })
    },
    quota_floating_window: {
      description: "打开或关闭 Quota Dock 桌面浮窗。关闭不存在的浮窗会按成功处理，并返回当前打开状态和站点展示配置。",
      inputSchema: strictObject({ action: { type: "string", enum: ["open", "close"] } }, ["action"]),
      outputSchema: withSchemaDefs(
        strictObject({
          isOpen: { type: "boolean" },
          providers: { type: "array", items: { $ref: "#/$defs/floatingProvider" } }
        }),
        ["floatingProvider"]
      )
    },
    quota_set_floating_visibility: {
      description: "设置指定站点是否显示在桌面浮窗中，保存后立即同步现有浮窗。返回当前浮窗状态和脱敏后的展示配置。",
      inputSchema: strictObject({ providerId, visible: { type: "boolean" } }, ["providerId", "visible"]),
      outputSchema: withSchemaDefs(
        strictObject({
          isOpen: { type: "boolean" },
          providers: { type: "array", items: { $ref: "#/$defs/floatingProvider" } },
          provider: { $ref: "#/$defs/floatingProvider" }
        }),
        ["floatingProvider"]
      )
    }
  },
  features: [
    {
      code: "quota-inquiry",
      explain: "Quota Dock - AI额度看板",
      cmds: ["Quota Dock", "AI额度看板", "余额查询", "额度查询", "中转站余额"]
    }
  ]
};

const generated = `${JSON.stringify(manifest, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const current = readFileSync(manifestPath, "utf8").replace(/\r\n/g, "\n");
  if (current !== generated) {
    console.error("public/plugin.json 已过期，请运行 npm run manifest:generate");
    process.exitCode = 1;
  }
} else {
  writeFileSync(manifestPath, generated, "utf8");
}
