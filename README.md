# Webpack API Loader

Webpack API Loader 是一个用于授权安全测试的 Chrome 扩展。它可以自动发现 webpack 打包站点中的入口 JS、懒加载分包和常见 chunk 映射，抓取 JS 文本后提取 API 接口、URL 与敏感线索，帮助安全开发、渗透测试和 SRC 信息收集工作更快完成前端接口梳理。

> 本工具默认只读取和分析 JS 静态资源，不会主动请求识别出的业务 API。

## 功能特性

- 自动收集当前页面的 `<script>` 资源和 Performance 资源记录。
- 识别 webpack runtime 中的 `publicPath`、chunk 映射和懒加载分包路径。
- 递归抓取分包 JS，尽可能覆盖未被页面主动加载的业务模块。
- 支持后台代理抓取 JS 文本，降低 CORS、跨域静态资源导致的读取失败。
- 提取 `fetch`、`axios`、`request`、`http/service`、`url/path/api/endpoint` 等常见写法中的接口。
- 提取 JWT、内网 IP、Swagger/OpenAPI 线索、敏感关键字等辅助信息。
- 支持复制带方法接口、复制纯接口、导出 JSON。
- 可选将分包脚本注入页面，方便在 DevTools Sources 中观察分包。

## 目录结构

```text
webpack-api-loader-extension/
├── manifest.json      # Chrome MV3 扩展配置
├── background.js      # 后台抓取代理和 JSON 下载
├── content.js         # 页面脚本收集、分包发现、接口提取核心逻辑
├── pageProbe.js       # 页面主世界 webpack runtime 探针
├── popup.html         # 插件弹窗页面
├── popup.css          # 弹窗样式
├── popup.js           # 弹窗交互逻辑
└── README.md          # 使用说明
```

## 安装方法

1. 打开 Chrome 浏览器。
2. 访问 `chrome://extensions/`。
3. 开启右上角的“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择 `webpack-api-loader-extension` 目录。
6. 安装成功后，浏览器工具栏会出现 `Webpack API Loader` 插件入口。

## 快速使用

1. 打开已授权测试的目标网站。
2. 点击浏览器工具栏中的 `Webpack API Loader`。
3. 保持默认选项，点击“扫描并加载分包”。
4. 扫描完成后，在“接口”“分包”“线索”“日志”标签中查看结果。
5. 根据需要点击“复制接口”“复制纯接口”或“导出 JSON”。

## 按钮说明

- `扫描并加载分包`：收集当前页面 JS，递归发现并抓取 webpack 分包，然后提取接口。
- `刷新`：刷新当前弹窗中的扫描结果。
- `清空`：清空当前页面已保存的扫描结果。
- `复制接口`：复制带请求方法的接口列表，例如 `POST /api/user/login` 或 `ANY /v2/getpublickey`。
- `复制纯接口`：只复制接口路径，不带请求方法，例如 `/channel/unicast?v=`。
- `导出 JSON`：导出完整扫描结果，包括页面信息、分包列表、接口列表、敏感线索和日志。

## 选项说明

- `深度`：递归发现分包的层级。常规目标建议使用 `2` 或 `3`。
- `包含 sourcemap`：识别并抓取 `sourceMappingURL` 指向的 sourcemap 文件。目标暴露 sourcemap 时可以打开。
- `注入脚本到页面`：将发现的分包脚本插入当前页面。这个选项可能触发前端模块注册或页面副作用，建议只在需要让 DevTools Sources 看到分包时使用。

## 输出格式

`复制接口` 输出示例：

```text
ANY /v2/getpublickey
POST /api/user/login
GET /api/user/profile?id=
```

`复制纯接口` 输出示例：

```text
/v2/getpublickey
/api/user/login
/api/user/profile?id=
```

其中 `ANY` 表示插件在 JS 中识别到了接口路径，但没有从附近代码可靠判断 HTTP 方法。它不是一种真实业务方法，也不是接口名前缀。

## 识别逻辑

插件会从以下位置提取接口和线索：

- `fetch("/api/example", { method: "POST" })`
- `axios.get("/api/example")`
- `axios.post("/api/example")`
- `request({ url: "/api/example", method: "POST" })`
- `service({ url: "/api/example" })`
- `url: "/api/example"`
- `path: "/api/example"`
- `api: "/api/example"`
- `endpoint: "/api/example"`
- JS 字符串中的绝对 URL 和疑似 API 相对路径

接口提取基于静态分析和正则匹配，结果用于信息收集和测试线索整理，最终请求方法、参数、鉴权要求仍需要人工结合上下文验证。

## 使用建议

- 优先使用默认模式扫描，确认结果后再决定是否启用“注入脚本到页面”。
- 如果接口大量显示为 `ANY`，可以结合 JS 调用上下文、浏览器 Network 面板或业务动作进一步确认方法。
- `/static/`、`.html`、`ueditor/` 等结果更可能是静态路径或管理组件线索，不一定是业务 API。
- 对导出的接口进行测试时，请遵守授权范围、测试窗口和目标规则。

## 常见问题

### 扫描不到结果

- 刷新目标页面后重新打开插件。
- 确认目标页面确实加载了 JS 资源。
- 如果页面是特殊协议、Chrome 内置页或扩展页，content script 可能无法注入。

### 分包抓取失败

- 目标静态资源可能需要登录态、Referer、Cookie 或特定防盗链策略。
- 目标可能使用 CDN、动态 publicPath 或运行时拼接路径，候选分包 URL 需要人工筛选。
- 可以提高扫描深度，或者开启 sourcemap 识别辅助分析。

### 为什么有重复接口

同一接口可能在多个分包或多个调用方式中出现。插件会对复制结果做基础去重，但 JSON 导出会保留更多来源信息，方便追踪接口来自哪个 JS 文件。

### 为什么有 `ANY`

`ANY` 表示未知请求方法。常见于接口以普通字符串、配置字段或动态请求封装形式出现，例如：

```js
const api = "/v2/getpublickey";
const config = { url: "/v2/unite-send" };
```

如果源码中存在 `axios.post(...)`、`fetch(..., { method: "POST" })` 这类明确调用，插件会尽量识别为具体方法。

## 安全与合规

本工具仅用于以下场景：

- 已授权的渗透测试。
- 企业内部安全自查。
- SRC 或漏洞赏金规则允许范围内的信息收集。
- 安全开发、前端资产梳理和接口暴露面审计。

请不要将本工具用于未授权目标、非法访问、批量攻击或任何违反法律法规和目标规则的行为。使用本工具产生的测试行为和后果由使用者自行负责。

## 版本

当前版本：`1.0.0`

核心能力：

- Chrome Manifest V3。
- webpack 分包发现。
- JS 静态抓取和接口提取。
- 纯接口复制。
- JSON 导出。
