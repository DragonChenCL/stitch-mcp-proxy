# stitch-mcp-proxy

一个 Cloudflare Worker，同时完成：


- 代理 Google Stitch 官方 MCP：`https://stitch.googleapis.com/mcp`
- 支持 Stitch API Key，也支持 Google OAuth Bearer 透传
- 保留 Stitch 原有所有工具
- 新增 `fetch_stitch_screen_image`
- 新增 `fetch_stitch_image`
- 新增 `inspect_stitch_screen_image`
- 新增 `inspect_stitch_image`
- 新增 `upload_stitch_image`
- 新增 `upload_stitch_image_from_url`

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

你的 Google Stitch API Key。API Key 模式下最简单，Cloudflare 端保存即可。

### `STITCH_ACCESS_TOKEN`（可选）

Google OAuth access token。只建议临时测试，因为 access token 会过期；正式使用更推荐让 MCP 客户端通过 `Authorization: Bearer <token>` 动态传入。

OAuth scope 使用：

```text
https://www.googleapis.com/auth/aida
```

OAuth 模式建议同时设置普通变量 `STITCH_PROJECT_ID`（或 `GOOGLE_CLOUD_PROJECT`），Worker 会将其作为 `X-Goog-User-Project` 转发给 Google。

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

推荐把 Stitch Key 放 Cloudflare secret，因此 API Key 模式下 ChatGPT 端只需要桥接鉴权。

### OAuth 透传模式

如果 ChatGPT / MCP 客户端使用 Google OAuth，请把桥接鉴权和 Google OAuth 分开：

```text
https://YOUR-WORKER.workers.dev/mcp/你的_BRIDGE_TOKEN
Authorization: Bearer <Google OAuth access token>
```

不要再用 `Authorization: Bearer <BRIDGE_KEY>` 保护 Worker，否则同一个 Authorization 头无法同时承载 Google OAuth。桥接密码请放路径、`?token=`、`X-Bridge-Key` 或 `X-Proxy-Token`。

当请求还没有 Google 凭据时，Worker 会把请求原样转给官方 Stitch MCP，让 Google 返回真实 OAuth challenge，而不是本地伪造 initialize 成功。

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

## 7. 图片上传

当前 Worker 已实现两种上传方式：

- `upload_stitch_image`：直接传 base64 图片字节
- `upload_stitch_image_from_url`：Worker 先下载公开 HTTPS 图片，再上传到 Stitch

支持 PNG / JPG / JPEG / WEBP，调用与官方 `@google/stitch-sdk` 一致的 REST 路径：

```text
POST https://stitch.googleapis.com/v1/projects/{projectId}/screens:batchCreate
```

上传请求会复用当前 Stitch 鉴权：有 Google OAuth 时发送 Bearer + `X-Goog-User-Project`，否则使用 `X-Goog-Api-Key`。

## 8. 关于“透明背景 + 回传 Stitch”

现在完整链路已经具备：

```text
Stitch -> Agent 获取原图 -> 处理 PNG/透明通道 -> upload_stitch_image -> Stitch
```

Worker 本身不负责抠图或生成透明通道，只负责把真实图片字节可靠地取回和上传。


## 9. 图片上传策略与画布 placement

### Alpha / PNG

上传工具现在会先检查真实图片字节：

- PNG 原生 alpha / PNG `tRNS`：保持 `image/png`
- `backgroundRemoved: true`：必须使用 `image/png`
- 透明 WEBP：**拒绝上传**，不会只改 MIME 冒充 PNG，也不会让 Stitch 有机会把它转成 JPEG

Worker 当前没有内置可靠的无损 WEBP → PNG 解码/重编码能力，所以透明 WEBP 的安全行为是明确报错，调用方先转成 PNG 再上传。普通不透明 JPEG / WEBP 仍可上传。

### 原始分辨率

`upload_stitch_image` 和 `upload_stitch_image_from_url` 的正式上传路径始终发送原始图片字节，不做 preview resize。新增：

```json
{
  "preserveOriginalSize": true
}
```

默认即为 `true`。另外，`fetch_stitch_screen_image` / `inspect_stitch_screen_image` 不再在未传 `width` 时偷偷使用 Stitch screen width；只有显式传 `width` 才请求缩略图。

如果显式 resize 一个 PNG，而 Google 图片 CDN 返回了非 PNG，Worker 会放弃该 resize，返回原始 PNG，避免透明通道因为 JPEG 转码丢失。

### placement

两个上传工具都支持可选：

```json
{
  "placement": {
    "mode": "near_screen",
    "screenId": "bf475025c36a4626a5a48628f50c21e7",
    "gap": 40,
    "align": "top"
  }
}
```

支持模式：

- `near_screen`：优先右侧，碰撞后尝试下方，再继续下一行
- `absolute`：直接使用 `x / y`
- `asset_area`：优先识别 IMAGE screen 对应的局部密集区域，在该局部区域附近紧凑排布，不使用全局 `maxX + N`
- `auto`：显式 `screenId` → 最近更新的 IMAGE 素材 → `asset_area`

旧调用不传 `placement` 时保持兼容：仍由 Stitch 默认创建实例，只增加实例存在性校验，不主动搬动已有默认位置。

### screenInstance 的真实实现和限制

Stitch 官方 MCP 当前可以通过 `get_project` 读取 `screenInstances`，但没有公开的 MCP 工具更新 x/y。Worker 的流程是：

```text
BatchCreateScreens(createScreenInstances=true)
  -> get_project 验证 screenInstance
  -> (placement 指定时) PATCH /v1/projects/{projectId}?updateMask=screenInstances
  -> get_project 再次读取，校验实例和最终 x/y
```

如果 BatchCreateScreens 没有真正创建实例，Worker 会尝试通过同一个 project PATCH 补建实例；如果 PATCH 失败，返回结果会明确带：

```json
{
  "instanceCreated": false,
  "placementApplied": false,
  "reason": "..."
}
```

注意：这个 project PATCH 是 Stitch 当前未正式文档化的画布写入 workaround。OAuth 通常可用；API Key 在部分账号会返回 401/403。Worker 会把真实 HTTP 状态和原因返回，不会把“screen resource 创建成功”冒充成“画布实例创建/定位成功”。

成功时返回包含源图真实信息与最终实例坐标：

```json
{
  "ok": true,
  "screen": {
    "id": "...",
    "title": "...",
    "width": 1024,
    "height": 1024,
    "mimeType": "image/png",
    "format": "png",
    "hasAlpha": true,
    "nativeAlphaChannel": true
  },
  "instanceCreated": true,
  "placementApplied": true,
  "instance": {
    "id": "...",
    "x": 2692,
    "y": -1048,
    "width": 512,
    "height": 512
  }
}
```

### 图片检查字段

以下四个工具统一返回/报告：

- `mimeType`
- `format`
- `width`
- `height`
- `hasAlpha`
- `nativeAlphaChannel`

工具：`fetch_stitch_image`、`fetch_stitch_screen_image`、`inspect_stitch_image`、`inspect_stitch_screen_image`。
