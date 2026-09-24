# stitch-mcp-proxy

一个 Cloudflare Worker，同时完成：


- 代理 Google Stitch 官方 MCP：`https://stitch.googleapis.com/mcp`
- 服务端注入 `X-Goog-Api-Key`
- 保留 Stitch 原有所有工具
- 新增 `fetch_stitch_screen_image`
- 新增 `fetch_stitch_image`
- 新增 `inspect_stitch_screen_image`
- 新增 `inspect_stitch_image`

这解决了一个实际问题：Stitch 的 `get_screen` 返回 `screenshot.downloadUrl`，但某些 Agent/运行环境不能直接访问 Google 图片 CDN。这个 Worker 在 Cloudflare 侧下载真实图片字节，再通过 MCP `image` content 返回给模型。

## 目录

```text
.
├── package.json
├── wrangler.toml
├── .gitignore
└── src
    └── index.js
```

## 1. Cloudflare Secrets

推荐在 Cloudflare Worker 的 **Settings → Variables and Secrets** 设置两个 Secret：

### `STITCH_API_KEY`

你的 Google Stitch API Key。

### `BRIDGE_KEY` / `PROXY_TOKEN`

两者都可以作为 Worker 的访问密钥。新配置推荐使用 `BRIDGE_KEY`；旧配置中的 `PROXY_TOKEN` 会继续兼容，不需要改名或重新生成。

例如：

```text
stitch_bridge_请换成一串随机长密码
```

不要把这些 Secret 提交到 GitHub。

> 兼容旧配置：如果你不设置 `STITCH_API_KEY`，Worker 仍可接受客户端传入的 `X-Goog-Api-Key`。但推荐使用 Cloudflare Secret。

## 2. 部署

```bash
npm install
npx wrangler secret put STITCH_API_KEY
npx wrangler secret put BRIDGE_KEY
npm run deploy
```

也可以把仓库连接到 Cloudflare Workers Builds，部署命令使用：

```bash
npm run deploy
```

## 3. 测试

```bash
curl https://YOUR-WORKER.workers.dev/health
```

应看到类似：

```json
{
  "ok": true,
  "service": "stitch-mcp-proxy",
  "stitchApiKeyConfigured": true,
  "bridgeKeyConfigured": true
}
```

## 4. ChatGPT / MCP 配置

MCP URL（推荐给单人/私有 ChatGPT Dev MCP，兼容旧配置）：

```text
https://YOUR-WORKER.workers.dev/mcp/你的_TOKEN
```

其中 TOKEN 可以是 Cloudflare 中配置的 `PROXY_TOKEN` 或 `BRIDGE_KEY`。

也支持不把 token 放进 URL，改用：

```text
https://YOUR-WORKER.workers.dev/mcp
```

并携带请求头：

```text
X-Bridge-Key: 你的 BRIDGE_KEY
```

另外也兼容：

```text
Authorization: Bearer 你的_TOKEN
X-Proxy-Token: 你的_TOKEN
https://YOUR-WORKER.workers.dev/mcp?token=你的_TOKEN
```

如果你没有设置 Cloudflare `STITCH_API_KEY` secret，则还需要：

```text
X-Goog-Api-Key: 你的 Stitch API Key
```

推荐把 Stitch Key 放 Cloudflare secret，因此 ChatGPT 端只需要 `X-Bridge-Key`。

## 5. 新增工具

### `fetch_stitch_screen_image`

最推荐。

输入：

```json
{
  "projectId": "5541569878570068105",
  "screenId": "95a39bf5af0c4262b7241a36c61e160d"
}
```

Worker 会自动：

1. 调 Stitch `get_screen`
2. 找到 `screenshot.downloadUrl`
3. 从 Google CDN 下载图片
4. 以 MCP image content 返回真实图片

因此 Agent 可以直接“看见”图片，不需要用户下载再上传。

### `inspect_stitch_screen_image`

检查真实文件：

- MIME type
- 文件大小
- 图片尺寸（可检测时）
- PNG 是否存在 alpha 通道 / `tRNS`

非常适合验证所谓“透明 PNG”到底是不是真透明。

### `fetch_stitch_image`

已有 `screenshot.downloadUrl` 时直接下载。

### `inspect_stitch_image`

已有 URL 时直接检查文件属性。

## 6. 安全说明

Worker 只允许图片桥接访问以下主机：

- `*.googleusercontent.com`
- `storage.googleapis.com`

避免把它变成任意 URL SSRF 代理。

如果设置了 `BRIDGE_KEY` 或 `PROXY_TOKEN`，MCP 请求必须通过任一受支持方式提供正确 token：

```text
/mcp/<token>
/mcp?token=<token>
X-Bridge-Key: <token>
X-Proxy-Token: <token>
Authorization: Bearer <token>
```

## 7. 关于“透明背景 + 回传 Stitch”

这个版本首先把最关键的 **Stitch → Agent 原始图片数据链路** 打通。

Google Stitch SDK 当前提供 `project.uploadImage()`，可以把 PNG/JPG/WEBP 上传成 Stitch screen；后续如果需要，可以继续在同一个 Worker 增加“图片处理 + 上传”工具，而不需要再建第二个 Worker。

当前这版不伪造未验证的上传 REST endpoint，避免因为 Stitch API 变化导致 Worker 看似部署成功、实际上传失败。
