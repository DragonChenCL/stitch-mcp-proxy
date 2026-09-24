/**
 * Stitch MCP Proxy + Image Bridge
 *
 * One Cloudflare Worker endpoint that:
 *  1) transparently proxies the official Google Stitch MCP server;
 *  2) injects the Stitch API key server-side;
 *  3) adds local MCP tools that can fetch the REAL screenshot bytes;
 *  4) can fetch a screen image directly from projectId + screenId.
 *
 * MCP endpoint: /mcp
 * Health:       /health
 *
 * Secrets:
 *   STITCH_API_KEY  recommended: keep the Google key only in Cloudflare
 *   BRIDGE_KEY      recommended: protects your public Worker endpoint
 *
 * Backward compatibility:
 *   If STITCH_API_KEY is not configured as a secret, an incoming
 *   X-Goog-Api-Key header will still be accepted and forwarded.
 */

const DEFAULT_STITCH_MCP_URL = "https://stitch.googleapis.com/mcp";
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const LOCAL_TOOLS = [
  {
    name: "fetch_stitch_screen_image",
    description:
      "Fetch the real screenshot image bytes for a Stitch screen. Give projectId and screenId; this proxy calls Stitch get_screen internally, downloads screenshot.downloadUrl, and returns the image directly to the model.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "Bare Stitch project ID, without the projects/ prefix."
        },
        screenId: {
          type: "string",
          description: "Bare Stitch screen ID, without the screens/ prefix."
        },
        width: {
          type: "integer",
          minimum: 1,
          maximum: 4096,
          description:
            "Optional download width override. If omitted, the width returned by Stitch get_screen is used."
        }
      },
      required: ["projectId", "screenId"],
      additionalProperties: false
    }
  },
  {
    name: "fetch_stitch_image",
    description:
      "Fetch the real image bytes behind a Stitch screenshot.downloadUrl and return the image directly to the model.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "The screenshot.downloadUrl returned by Stitch get_screen/list_screens."
        },
        width: {
          type: "integer",
          minimum: 1,
          maximum: 4096,
          description:
            "Optional width. For Google FIFE image URLs the bridge requests this width."
        }
      },
      required: ["url"],
      additionalProperties: false
    }
  },
  {
    name: "inspect_stitch_screen_image",
    description:
      "Inspect the actual file for a Stitch screen screenshot without returning the full image. Returns MIME type, byte size, dimensions where detectable, and PNG alpha-channel information.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        screenId: { type: "string" },
        width: {
          type: "integer",
          minimum: 1,
          maximum: 4096
        }
      },
      required: ["projectId", "screenId"],
      additionalProperties: false
    }
  },
  {
    name: "inspect_stitch_image",
    description:
      "Inspect a Stitch screenshot.downloadUrl. Returns MIME type, byte size, dimensions where detectable, and PNG alpha-channel information.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        width: {
          type: "integer",
          minimum: 1,
          maximum: 4096
        }
      },
      required: ["url"],
      additionalProperties: false
    }
  }
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "stitch-mcp-proxy",
        upstream: stitchMcpUrl(env),
        stitchApiKeyConfigured: Boolean(env.STITCH_API_KEY),
        bridgeKeyConfigured: Boolean(env.BRIDGE_KEY),
        localTools: LOCAL_TOOLS.map((x) => x.name),
        time: new Date().toISOString()
      });
    }

    if (url.pathname !== "/mcp") {
      return new Response(
        [
          "stitch-mcp-proxy",
          "",
          "MCP endpoint: POST/GET/DELETE /mcp",
          "Health:       GET /health"
        ].join("\n"),
        {
          status: 200,
          headers: {
            ...corsHeaders(),
            "content-type": "text/plain; charset=utf-8"
          }
        }
      );
    }

    if (!isAuthorized(request, env)) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const apiKey = getStitchApiKey(request, env);
    if (!apiKey) {
      return jsonResponse(
        {
          error: "Missing Stitch API key",
          hint:
            "Set Cloudflare secret STITCH_API_KEY, or send X-Goog-Api-Key in the request."
        },
        500
      );
    }

    // Streamable HTTP MCP may use GET/DELETE for session operations.
    // Only POST JSON-RPC requests need inspection; everything else is proxied.
    if (request.method !== "POST") {
      return proxyRawToStitch(request, env, apiKey);
    }

    const rawBody = await request.text();
    let rpc;

    try {
      rpc = JSON.parse(rawBody);
    } catch {
      return proxyRawToStitch(request, env, apiKey, rawBody);
    }

    // Batch/unknown payloads are forwarded untouched.
    if (!rpc || Array.isArray(rpc) || rpc.jsonrpc !== "2.0") {
      return proxyRawToStitch(request, env, apiKey, rawBody);
    }

    if (rpc.method === "tools/list") {
      return handleToolsList(request, env, apiKey, rawBody);
    }

    if (rpc.method === "tools/call") {
      const toolName = rpc?.params?.name;
      if (LOCAL_TOOLS.some((tool) => tool.name === toolName)) {
        return handleLocalTool(request, env, apiKey, rpc);
      }
    }

    return proxyRawToStitch(request, env, apiKey, rawBody);
  }
};

async function handleToolsList(request, env, apiKey, rawBody) {
  const upstream = await fetchStitch(request, env, apiKey, rawBody);
  const parsed = await parseJsonRpcResponse(upstream);

  if (!parsed.rpc) {
    // If Google changes its transport format, fail safe: return upstream untouched.
    return new Response(parsed.raw, {
      status: upstream.status,
      headers: copyResponseHeaders(upstream.headers)
    });
  }

  if (!parsed.rpc.result) parsed.rpc.result = {};
  if (!Array.isArray(parsed.rpc.result.tools)) parsed.rpc.result.tools = [];

  const existing = new Set(parsed.rpc.result.tools.map((tool) => tool?.name));
  for (const tool of LOCAL_TOOLS) {
    if (!existing.has(tool.name)) parsed.rpc.result.tools.push(tool);
  }

  const headers = copyResponseHeaders(upstream.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.delete("content-length");

  return new Response(JSON.stringify(parsed.rpc), {
    status: upstream.status,
    headers
  });
}

async function handleLocalTool(request, env, apiKey, rpc) {
  const id = rpc.id ?? null;
  const name = rpc?.params?.name;
  const args = rpc?.params?.arguments || {};

  try {
    if (name === "fetch_stitch_image") {
      const asset = await fetchImageAsset(args.url, args.width, env);
      return rpcToolSuccess(id, imageToolContent(asset, args.url));
    }

    if (name === "inspect_stitch_image") {
      const asset = await fetchImageAsset(args.url, args.width, env);
      return rpcToolSuccess(id, [
        {
          type: "text",
          text: JSON.stringify(inspectImage(asset), null, 2)
        }
      ]);
    }

    if (
      name === "fetch_stitch_screen_image" ||
      name === "inspect_stitch_screen_image"
    ) {
      const projectId = requireBareId(args.projectId, "projectId");
      const screenId = requireBareId(args.screenId, "screenId");
      const screenName = `projects/${projectId}/screens/${screenId}`;

      const screenCall = await callUpstreamTool(
        request,
        env,
        apiKey,
        "get_screen",
        { name: screenName }
      );

      const screenInfo = extractScreenInfo(screenCall);
      if (!screenInfo.downloadUrl) {
        throw new Error(
          "Stitch get_screen succeeded but screenshot.downloadUrl was not found in the response."
        );
      }

      const width = normalizeWidth(args.width ?? screenInfo.width);
      const asset = await fetchImageAsset(screenInfo.downloadUrl, width, env);

      if (name === "fetch_stitch_screen_image") {
        return rpcToolSuccess(
          id,
          imageToolContent(asset, screenInfo.downloadUrl, {
            projectId,
            screenId,
            screenName,
            screenTitle: screenInfo.title ?? null,
            stitchWidth: screenInfo.width ?? null,
            stitchHeight: screenInfo.height ?? null
          })
        );
      }

      return rpcToolSuccess(id, [
        {
          type: "text",
          text: JSON.stringify(
            {
              projectId,
              screenId,
              screenName,
              screenTitle: screenInfo.title ?? null,
              stitchWidth: screenInfo.width ?? null,
              stitchHeight: screenInfo.height ?? null,
              ...inspectImage(asset)
            },
            null,
            2
          )
        }
      ]);
    }

    return rpcToolError(id, `Unknown local tool: ${name}`);
  } catch (error) {
    return rpcToolError(
      id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function callUpstreamTool(request, env, apiKey, name, args) {
  const payload = {
    jsonrpc: "2.0",
    id: `bridge-${crypto.randomUUID()}`,
    method: "tools/call",
    params: {
      name,
      arguments: args
    }
  };

  const upstream = await fetchStitch(
    request,
    env,
    apiKey,
    JSON.stringify(payload)
  );

  const parsed = await parseJsonRpcResponse(upstream);

  if (!upstream.ok) {
    throw new Error(
      `Stitch upstream HTTP ${upstream.status}: ${truncate(parsed.raw, 500)}`
    );
  }

  if (!parsed.rpc) {
    throw new Error(
      `Could not parse Stitch MCP response: ${truncate(parsed.raw, 500)}`
    );
  }

  if (parsed.rpc.error) {
    throw new Error(
      `Stitch MCP error: ${parsed.rpc.error.message || JSON.stringify(parsed.rpc.error)}`
    );
  }

  return parsed.rpc.result;
}

function extractScreenInfo(callResult) {
  const candidates = [];

  if (callResult && typeof callResult === "object") {
    candidates.push(callResult);
    if (callResult.structuredContent) candidates.push(callResult.structuredContent);

    if (Array.isArray(callResult.content)) {
      for (const item of callResult.content) {
        if (item?.type === "text" && typeof item.text === "string") {
          try {
            candidates.push(JSON.parse(item.text));
          } catch {
            // Ignore non-JSON text.
          }
        }
      }
    }
  }

  for (const candidate of candidates) {
    const found = findObjectWithScreenshot(candidate);
    if (found) {
      return {
        downloadUrl: found.screenshot?.downloadUrl,
        width: found.width,
        height: found.height,
        title: found.title,
        name: found.name
      };
    }
  }

  return {};
}

function findObjectWithScreenshot(value, depth = 0) {
  if (!value || depth > 8) return null;

  if (typeof value === "object" && !Array.isArray(value)) {
    if (value.screenshot?.downloadUrl) return value;

    for (const child of Object.values(value)) {
      const found = findObjectWithScreenshot(child, depth + 1);
      if (found) return found;
    }
  }

  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findObjectWithScreenshot(child, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

async function fetchImageAsset(rawUrl, width, env) {
  const assetUrl = buildStitchAssetUrl(rawUrl, width);
  const response = await fetch(assetUrl, {
    method: "GET",
    headers: {
      accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
      "user-agent": "stitch-mcp-proxy/1.0"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(
      `Failed to download Stitch image: HTTP ${response.status} ${response.statusText}`
    );
  }

  const contentTypeHeader = response.headers.get("content-type") || "";
  const contentType = contentTypeHeader.split(";")[0].trim().toLowerCase();

  if (!contentType.startsWith("image/")) {
    throw new Error(
      `Stitch asset is not an image. Content-Type: ${contentTypeHeader || "unknown"}`
    );
  }

  const buffer = await response.arrayBuffer();
  const maxBytes = Number(env.MAX_IMAGE_BYTES || DEFAULT_MAX_IMAGE_BYTES);

  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error("MAX_IMAGE_BYTES must be a positive number.");
  }

  if (buffer.byteLength > maxBytes) {
    throw new Error(
      `Image is too large (${buffer.byteLength} bytes). Limit is ${maxBytes} bytes.`
    );
  }

  return {
    requestedUrl: assetUrl,
    finalUrl: response.url || assetUrl,
    mimeType: normalizeImageMime(contentType),
    bytes: new Uint8Array(buffer),
    cacheControl: response.headers.get("cache-control") || null
  };
}

function imageToolContent(asset, sourceUrl, extra = {}) {
  return [
    {
      type: "text",
      text: JSON.stringify({
        ok: true,
        sourceUrl,
        fetchedUrl: asset.requestedUrl,
        finalUrl: asset.finalUrl,
        mimeType: asset.mimeType,
        bytes: asset.bytes.byteLength,
        ...extra
      })
    },
    {
      type: "image",
      data: bytesToBase64(asset.bytes),
      mimeType: asset.mimeType
    }
  ];
}

function inspectImage(asset) {
  const metadata = detectImageMetadata(asset.bytes, asset.mimeType);

  return {
    ok: true,
    fetchedUrl: asset.requestedUrl,
    finalUrl: asset.finalUrl,
    mimeType: asset.mimeType,
    bytes: asset.bytes.byteLength,
    cacheControl: asset.cacheControl,
    ...metadata
  };
}

function detectImageMetadata(bytes, mimeType) {
  if (isPng(bytes)) return inspectPng(bytes);
  if (isJpeg(bytes)) return inspectJpeg(bytes);
  if (isWebp(bytes)) return inspectWebp(bytes);

  return {
    format: mimeType || "unknown",
    width: null,
    height: null,
    hasAlpha: null
  };
}

function isPng(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  return bytes.length >= 8 && sig.every((v, i) => bytes[i] === v);
}

function inspectPng(bytes) {
  if (bytes.length < 33) {
    return { format: "png", width: null, height: null, hasAlpha: null };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  let hasTransparencyChunk = false;

  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (offset + 12 + length > bytes.length) break;

    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    );

    if (type === "tRNS") hasTransparencyChunk = true;
    if (type === "IEND") break;
    offset += 12 + length;
  }

  const nativeAlpha = colorType === 4 || colorType === 6;

  return {
    format: "png",
    width,
    height,
    bitDepth,
    colorType,
    hasAlpha: nativeAlpha || hasTransparencyChunk,
    nativeAlphaChannel: nativeAlpha,
    hasTransparencyChunk
  };
}

function isJpeg(bytes) {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function inspectJpeg(bytes) {
  let offset = 2;

  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1];
    offset += 2;

    // Standalone markers.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    if (offset + 2 > bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;

    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isSof && length >= 7) {
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return { format: "jpeg", width, height, hasAlpha: false };
    }

    offset += length;
  }

  return { format: "jpeg", width: null, height: null, hasAlpha: false };
}

function isWebp(bytes) {
  return (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  );
}

function inspectWebp(bytes) {
  if (bytes.length < 30) {
    return { format: "webp", width: null, height: null, hasAlpha: null };
  }

  const chunk = ascii(bytes, 12, 4);

  if (chunk === "VP8X" && bytes.length >= 30) {
    const flags = bytes[20];
    const hasAlpha = Boolean(flags & 0x10);
    const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
    const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    return { format: "webp", width, height, hasAlpha };
  }

  return { format: "webp", width: null, height: null, hasAlpha: null };
}

function ascii(bytes, offset, length) {
  let out = "";
  for (let i = 0; i < length && offset + i < bytes.length; i++) {
    out += String.fromCharCode(bytes[offset + i]);
  }
  return out;
}

function buildStitchAssetUrl(rawUrl, width) {
  if (!rawUrl || typeof rawUrl !== "string") {
    throw new Error("url is required");
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid image URL");
  }

  if (url.protocol !== "https:") {
    throw new Error("Only HTTPS image URLs are allowed");
  }

  if (!isAllowedImageHost(url.hostname)) {
    throw new Error(`Image host is not allowed: ${url.hostname}`);
  }

  const normalizedWidth = normalizeWidth(width);
  let result = url.toString();

  if (normalizedWidth && isGoogleFifeHost(url.hostname)) {
    // Stitch currently returns FIFE URLs such as lh3.googleusercontent.com/aida/....
    // If no transform suffix is present, ask FIFE for the screen's native width.
    const lastPathPart = url.pathname.split("/").pop() || "";
    const hasFifeSuffix = /=(?:w|s)\d+/i.test(lastPathPart) || /=(?:w|s)\d+/i.test(result);
    if (!hasFifeSuffix) result += `=w${normalizedWidth}`;
  }

  return result;
}

function isAllowedImageHost(hostname) {
  const h = hostname.toLowerCase();
  return (
    h === "lh3.googleusercontent.com" ||
    h.endsWith(".googleusercontent.com") ||
    h === "storage.googleapis.com"
  );
}

function isGoogleFifeHost(hostname) {
  const h = hostname.toLowerCase();
  return h === "lh3.googleusercontent.com" || h.endsWith(".googleusercontent.com");
}

function normalizeWidth(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 4096) return null;
  return n;
}

function normalizeImageMime(mimeType) {
  switch ((mimeType || "").toLowerCase()) {
    case "image/png":
      return "image/png";
    case "image/jpeg":
    case "image/jpg":
      return "image/jpeg";
    case "image/webp":
      return "image/webp";
    case "image/gif":
      return "image/gif";
    case "image/avif":
      return "image/avif";
    default:
      return mimeType || "application/octet-stream";
  }
}

function requireBareId(value, field) {
  if (!value || typeof value !== "string") {
    throw new Error(`${field} is required`);
  }

  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  if (trimmed.includes("/")) {
    throw new Error(`${field} must be the bare ID, without projects/ or screens/ prefix`);
  }
  return trimmed;
}

async function proxyRawToStitch(request, env, apiKey, rawBody) {
  return fetchStitch(request, env, apiKey, rawBody);
}

async function fetchStitch(request, env, apiKey, rawBody) {
  const headers = buildUpstreamHeaders(request.headers, apiKey);
  const init = {
    method: request.method,
    headers,
    redirect: "manual"
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = rawBody !== undefined ? rawBody : request.body;
  }

  return fetch(stitchMcpUrl(env), init);
}

function buildUpstreamHeaders(incoming, apiKey) {
  const headers = new Headers(incoming);

  headers.delete("host");
  headers.delete("content-length");
  headers.delete("x-bridge-key");

  // Never forward our own Bearer bridge password as Google auth.
  const auth = headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    headers.delete("authorization");
  }

  headers.set("x-goog-api-key", apiKey);
  return headers;
}

function stitchMcpUrl(env) {
  return env.STITCH_MCP_URL || DEFAULT_STITCH_MCP_URL;
}

function getStitchApiKey(request, env) {
  return env.STITCH_API_KEY || request.headers.get("x-goog-api-key") || "";
}

function isAuthorized(request, env) {
  if (!env.BRIDGE_KEY) return true;

  const direct = request.headers.get("x-bridge-key");
  if (direct && timingSafeStringEqual(direct, env.BRIDGE_KEY)) return true;

  const auth = request.headers.get("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return Boolean(match && timingSafeStringEqual(match[1], env.BRIDGE_KEY));
}

// Constant-ish time comparison for short shared secrets without Node dependencies.
function timingSafeStringEqual(a, b) {
  const aa = new TextEncoder().encode(String(a));
  const bb = new TextEncoder().encode(String(b));
  const length = Math.max(aa.length, bb.length);
  let diff = aa.length ^ bb.length;

  for (let i = 0; i < length; i++) {
    diff |= (aa[i % Math.max(aa.length, 1)] || 0) ^ (bb[i % Math.max(bb.length, 1)] || 0);
  }
  return diff === 0;
}

async function parseJsonRpcResponse(response) {
  const raw = await response.text();
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json") || raw.trim().startsWith("{")) {
    try {
      return { rpc: JSON.parse(raw), raw };
    } catch {
      return { rpc: null, raw };
    }
  }

  // Streamable HTTP may use SSE. Extract the first JSON-RPC data event.
  if (contentType.includes("text/event-stream") || raw.includes("data:")) {
    const events = raw.split(/\r?\n\r?\n/);
    for (const event of events) {
      const dataLines = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());

      if (!dataLines.length) continue;
      const data = dataLines.join("\n");
      try {
        const parsed = JSON.parse(data);
        if (parsed?.jsonrpc === "2.0") return { rpc: parsed, raw };
      } catch {
        // Continue scanning other events.
      }
    }
  }

  return { rpc: null, raw };
}

function rpcToolSuccess(id, content) {
  return jsonResponse({
    jsonrpc: "2.0",
    id,
    result: {
      content,
      isError: false
    }
  });
}

function rpcToolError(id, message) {
  return jsonResponse({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: message }],
      isError: true
    }
  });
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function copyResponseHeaders(source) {
  const headers = new Headers(source);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", "mcp-session-id");
  return headers;
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers":
      "Content-Type, Accept, Authorization, X-Bridge-Key, X-Goog-Api-Key, MCP-Session-Id, Last-Event-ID",
    "access-control-expose-headers": "MCP-Session-Id"
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function truncate(value, maxLength) {
  const s = String(value ?? "");
  return s.length <= maxLength ? s : `${s.slice(0, maxLength)}…`;
}
