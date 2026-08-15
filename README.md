<p align="center">
  <img src="public/logo.png" width="96" alt="Quota Dock Logo" />
</p>

<h1 align="center">Quota Dock</h1>

<p align="center">
  集中查询、展示和监控多个 AI 平台余额与套餐额度的 uTools 插件。
</p>

## 项目简介

Quota Dock 面向同时使用多个 AI API、Coding Plan 或中转站的用户，将分散在不同平台的账户余额、已用额度、总额度和重置时间汇总到一个看板中。项目提供主面板、桌面浮窗和 uTools MCP 工具三种使用方式，并支持按设定周期自动刷新数据。

## 主要功能

- 集中管理官方 AI 平台、中转站和自定义额度接口
- 按币种或单位汇总余额，展示站点状态、额度进度和重置时间
- 支持一个站点返回多项额度，例如余额、套餐配额和月度支出
- 内置官方平台预设，只需填写对应凭证即可查询
- 提供专业模式，可自定义请求地址、鉴权方式和 JSON 字段映射
- 支持定时刷新、单站点刷新和全部刷新
- 提供可置顶的桌面浮窗，并可单独控制各站点是否显示
- 支持跟随系统、浅色和深色三种显示模式
- 显示 uTools 数据同步状态
- 通过 uTools MCP 向 AI Agent 提供脱敏后的额度查询与健康检查能力

## 支持平台

### 按量 API

| 平台 | 默认单位 |
| --- | --- |
| DeepSeek API | CNY |
| Kimi API（国内） | CNY |
| Kimi API（国际） | USD |
| 阶跃星辰 StepFun API | CNY |
| 硅基流动（国内） | CNY |
| SiliconFlow（国际） | USD |
| 302.AI | USD |
| Novita AI | USD |
| OpenRouter API Key 额度 | USD |
| AIHubMix | USD |

### Coding / Token Plan

| 平台 | 默认单位 |
| --- | --- |
| MiniMax Token Plan | Tokens |
| 智谱 GLM Coding Plan（国内） | 次 |
| Z.AI Coding Plan（国际） | 次 |

### 管理与账单

| 平台 | 所需凭证 |
| --- | --- |
| xAI / Grok 账单 | 具有 Team 账单读取权限的 Management Key |
| OpenAI Organization | Admin API Key |
| Anthropic Organization | Admin API Key |
| OpenRouter Account Credits | API Key |

> 平台接口和权限要求可能发生变化。普通项目 Key 无法替代 OpenAI、Anthropic 等平台要求的管理凭证，请按添加站点时的提示配置最小必要权限。

## 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) 与 npm
- [uTools](https://www.u.tools/)
- uTools 插件应用开发者工具

### 构建并加载

在项目根目录执行：

```bash
npm install
npm run build
```

构建产物会生成到 `dist/`。在 uTools 插件应用开发者工具中载入 `dist/plugin.json`，然后运行插件即可。

> Quota Dock 依赖 uTools 的 preload、数据库、加密存储和窗口 API。直接在普通浏览器中打开页面只能加载前端界面，无法完成站点管理、额度查询或浮窗操作。

## 使用方法

1. 打开 Quota Dock，点击“添加站点”。
2. 选择“官方”并挑选内置平台，或选择“专业模式”配置自定义接口。
3. 填写 API Key 或平台要求的管理凭证。
4. 发送测试请求，确认额度数据能够正确解析。
5. 保存站点；插件会立即刷新，并按照设定的更新间隔继续检查。
6. 点击顶部“浮窗”打开桌面监控窗口，通过每个站点的“浮窗”开关控制展示范围。

## 专业模式

专业模式适用于中转站以及其他返回 JSON 的额度接口，内置以下模板：

- `Sub2API - 订阅`
- `Sub2API - 刷新限额`
- `专业`（完全自定义）

可配置内容包括：

- `Base URL` 与请求路径
- `GET` 或 `POST` 请求
- Header 或 Body 鉴权
- 自定义 Headers JSON 与 Body JSON
- 余额、已用额度、总额度、重置时间和单位的 JSON 路径
- 手填总额度、默认单位和价格倍率
- 自动刷新间隔

Headers 和 Body 中可使用 `{{token}}` 作为当前站点凭证的占位符。测试请求成功后，可以直接从响应字段列表中选择并绑定相应的 JSON 路径。

## MCP 工具

插件注册了以下 uTools MCP 工具，供支持 MCP 的 AI Agent 调用：

| 工具 | 用途 |
| --- | --- |
| `quota_overview` | 刷新全部站点并返回额度总览、状态统计和分单位汇总 |
| `quota_provider_detail` | 刷新并返回指定站点的全部额度项 |
| `quota_refresh` | 按到期、全部或指定站点范围刷新额度 |
| `quota_health_check` | 检查缺少凭证、刷新失败、数据过期和低剩余额度等问题 |
| `quota_supported_platforms` | 查询内置平台预设及其安全摘要 |
| `quota_floating_window` | 打开或关闭桌面浮窗 |
| `quota_set_floating_visibility` | 设置指定站点是否显示在浮窗中 |

MCP 查询结果经过脱敏，不包含 API Key、请求 URL、请求配置或原始上游响应。单个站点刷新失败时，批量查询仍会继续处理其他站点。

## 数据与安全

- API Key 使用 uTools `dbCryptoStorage` 保存，不写入普通站点配置文档。
- 站点配置与最近一次额度快照保存在 uTools 数据库中。
- 删除站点时会同时清理对应凭证，并保留删除标记以处理云端旧数据回流。
- 额度请求由插件直接发送到官方平台或用户配置的服务地址。
- MCP 输出只暴露额度状态所需的脱敏字段。

请仅使用来源可信的 API 地址，并为查询凭证授予最小必要权限。

## 开发命令

| 命令 | 说明 |
| --- | --- |
| `npm run test` | 运行额度核心、MCP、官方预设、数据迁移、删除流程和主题测试 |
| `npm run build` | 执行 TypeScript 类型检查并构建主面板与浮窗 |
| `npm run verify` | 依次运行全部测试和生产构建 |

## 技术栈

- Vue 3
- TypeScript
- Vite 6
- Lucide Vue
- uTools preload、数据库、加密存储、窗口与 MCP API

## 项目结构

```text
Quota-Dock/
├─ public/
│  ├─ libs/                 # 额度核心、平台预设、数据存储与 MCP 逻辑
│  ├─ plugin.json           # uTools 插件清单及 MCP Schema
│  └─ preload.js            # uTools API 桥接与浮窗管理
├─ scripts/                 # 自动化测试脚本
├─ src/
│  ├─ floating/             # 桌面浮窗入口
│  ├─ renderer/             # 主看板入口
│  ├─ shared/               # 类型、格式化、主题和桥接代码
│  └─ styles/               # 全局样式
├─ floating.html            # 浮窗构建入口
├─ index.html               # 主面板构建入口
└─ vite.config.mts          # Vite 多入口构建配置
```
