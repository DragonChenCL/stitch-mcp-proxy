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
 *   PROXY_TOKEN     backward-compatible alias for BRIDGE_KEY
 *
 * Backward compatibility:
 *   If STITCH_API_KEY is not configured as a secret, an incoming
 *   X-Goog-Api-Key header will still be accepted and forwarded.
 */

const PROXY_VERSION = "2026-09-24-image-bridge-v2.1";
const DEFAULT_STITCH_MCP_URL = "https://stitch.googleapis.com/mcp";
const DEFAULT_STITCH_API_URL = "https://stitch.googleapis.com";
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_UPSTREAM_RPC_TIMEOUT_MS = 15_000;

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
  },
  {
    name: "upload_stitch_image_from_url",
    description:
      "Upload a PNG, JPEG, or WEBP image from a public HTTPS URL into a Stitch project as a new image screen.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "Bare Stitch project ID, without the projects/ prefix."
        },
        url: {
          type: "string",
          description: "Public HTTPS URL of a PNG, JPEG, or WEBP image."
        },
        title: {
          type: "string",
          description: "Optional title for the created Stitch screen."
        },
        createScreenInstances: {
          type: "boolean",
          description:
            "Whether to add the new screen to the project canvas. Defaults to true."
        }
      },
      required: ["projectId", "url"],
      additionalProperties: false
    }
  },
  {
    name: "upload_stitch_image",
    description:
      "Upload PNG, JPEG, or WEBP image bytes encoded as base64 into a Stitch project as a new image screen. Prefer upload_stitch_image_from_url when a public URL is available.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "Bare Stitch project ID, without the projects/ prefix."
        },
        fileContentBase64: {
          type: "string",
          description: "Base64-encoded image bytes, without a data: URL prefix."
        },
        mimeType: {
          type: "string",
          enum: ["image/png", "image/jpeg", "image/webp"]
        },
        title: {
          type: "string",
          description: "Optional title for the created Stitch screen."
        },
        createScreenInstances: {
          type: "boolean",
          description:
            "Whether to add the new screen to the project canvas. Defaults to true."
        }
      },
      required: ["projectId", "fileContentBase64", "mimeType"],
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
        version: PROXY_VERSION,
        upstream: stitchMcpUrl(env),
        apiBase: stitchApiBaseUrl(env),
        stitchApiKeyConfigured: Boolean(env.STITCH_API_KEY),
        bridgeKeyConfigured: Boolean(env.BRIDGE_KEY),
        proxyTokenConfigured: Boolean(env.PROXY_TOKEN),
        authConfigured: Boolean(env.BRIDGE_KEY || env.PROXY_TOKEN),
        authModes: [
          "path:/mcp/<token>",
          "query:?token=<token>",
          "header:X-Bridge-Key",
          "header:Authorization Bearer"
        ],
        localTools: LOCAL_TOOLS.map((x) => x.name),
        time: new Date().toISOString()
      });
    }

    if (url.pathname === "/selftest") {
      if (!isAuthorized(request, env, url)) {
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

      return handleSelfTest(env, apiKey);
    }

    if (!isMcpPath(url.pathname)) {
      return new Response(
        [
          "stitch-mcp-proxy",
          "",
          "MCP endpoint: POST/GET/DELETE /mcp",
          "MCP token:    POST/GET/DELETE /mcp/<token>",
          "Health:       GET /health",
          "Self-test:    GET /selftest"
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

    if (!isAuthorized(request, env, url)) {
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

    // A normal browser navigation uses GET + Accept: text/html. Do not forward
    // that to Google's MCP endpoint (which may return 405); return a safe
    // diagnostic response instead. Real MCP GET/SSE requests still proxy.
    if (request.method === "GET" && isBrowserNavigation(request)) {
      return jsonResponse({
        ok: true,
        service: "stitch-mcp-proxy",
        version: PROXY_VERSION,
        endpoint: "/mcp",
        authenticated: true,
        message:
          "MCP endpoint is reachable and the token is valid. Use an MCP client to connect; browser navigation is only a connectivity check.",
        localTools: LOCAL_TOOLS.map((tool) => tool.name)
      });
    }

    // Streamable HTTP MCP may use GET/DELETE for session operations.
    // Only POST JSON-RPC requests need inspection; non-browser GET/DELETE
    // requests are proxied to the upstream MCP server.
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

    if (rpc.method === "initialize") {
      return handleInitialize(request, env, apiKey, rawBody);
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

async function handleSelfTest(env, apiKey) {
  const protocolVersion = "2025-06-18";
  const initializePayload = {
    jsonrpc: "2.0",
    id: "selftest-init",
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: {
        name: "stitch-mcp-proxy-selftest",
        version: PROXY_VERSION
      }
    }
  };

  const initResponse = await fetch(stitchMcpUrl(env), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify(initializePayload)
  });
  const sessionId = initResponse.headers.get("mcp-session-id");
  const initContentType = initResponse.headers.get("content-type") || "";
  const initialized = await parseJsonRpcResponse(initResponse);

  if (!initialized.rpc || initialized.rpc.error) {
    return jsonResponse(
      {
        ok: false,
        version: PROXY_VERSION,
        stage: "initialize",
        httpStatus: initResponse.status,
        contentType: initContentType,
        error: initialized.rpc?.error || truncate(initialized.raw, 1000)
      },
      502
    );
  }

  const toolsPayload = {
    jsonrpc: "2.0",
    id: "selftest-tools",
    method: "tools/list",
    params: {}
  };
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-goog-api-key": apiKey,
    "mcp-protocol-version":
      initialized.rpc?.result?.protocolVersion || protocolVersion
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const toolsResponse = await fetch(stitchMcpUrl(env), {
    method: "POST",
    headers,
    body: JSON.stringify(toolsPayload)
  });
  const toolsContentType = toolsResponse.headers.get("content-type") || "";
  const toolsParsed = await parseJsonRpcResponse(toolsResponse);

  if (!toolsParsed.rpc || toolsParsed.rpc.error) {
    return jsonResponse(
      {
        ok: false,
        version: PROXY_VERSION,
        stage: "tools/list",
        httpStatus: toolsResponse.status,
        contentType: toolsContentType,
        sessionIdPresent: Boolean(sessionId),
        error: toolsParsed.rpc?.error || truncate(toolsParsed.raw, 1000)
      },
      502
    );
  }

  const upstreamTools = Array.isArray(toolsParsed.rpc?.result?.tools)
    ? toolsParsed.rpc.result.tools
    : [];
  const localNames = new Set(LOCAL_TOOLS.map((tool) => tool.name));
  const mergedTools = [
    ...LOCAL_TOOLS,
    ...upstreamTools.filter((tool) => !localNames.has(tool?.name))
  ];

  return jsonResponse({
    ok: true,
    version: PROXY_VERSION,
    sessionIdPresent: Boolean(sessionId),
    initialize: {
      httpStatus: initResponse.status,
      contentType: initContentType,
      upstreamServerInfo: initialized.rpc?.result?.serverInfo || null
    },
    toolsList: {
      httpStatus: toolsResponse.status,
      contentType: toolsContentType,
      upstreamToolCount: upstreamTools.length,
      localToolCount: LOCAL_TOOLS.length,
      mergedToolCount: mergedTools.length,
      localTools: LOCAL_TOOLS.map((tool) => tool.name),
      mergedTools: mergedTools.map((tool) => tool?.name).filter(Boolean)
    }
  });
}

async function handleInitialize(request, env, apiKey, rawBody) {
  const upstream = await fetchStitch(request, env, apiKey, rawBody);
  const parsed = await parseJsonRpcResponse(upstream);

  if (!parsed.rpc) {
    const requestRpc = safeParseJson(rawBody);
    return jsonResponse({
      jsonrpc: "2.0",
      id: requestRpc?.id ?? null,
      result: {
        protocolVersion: requestRpc?.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: {
          name: "stitch-mcp-proxy",
          version: PROXY_VERSION
        },
        instructions:
          "Google Stitch MCP proxied through stitch-mcp-proxy with image download, inspection, and upload bridge tools."
      }
    });
  }

  if (!parsed.rpc.result) parsed.rpc.result = {};
  const upstreamServerInfo = parsed.rpc.result.serverInfo || null;
  parsed.rpc.result.serverInfo = {
    name: "stitch-mcp-proxy",
    title: "Stitch MCP Proxy + Image Bridge",
    version: PROXY_VERSION
  };
  parsed.rpc.result._meta = {
    ...(parsed.rpc.result._meta || {}),
    proxyVersion: PROXY_VERSION,
    upstreamServerInfo
  };

  return jsonRpcResponse(parsed.rpc, upstream.status);
}

async function handleToolsList(request, env, apiKey, rawBody) {
  const requestRpc = safeParseJson(rawBody);

  try {
    const upstream = await fetchStitch(request, env, apiKey, rawBody);
    const parsed = await parseJsonRpcResponse(upstream);

    if (!parsed.rpc) {
      return localToolsFallbackResponse(
        requestRpc?.id ?? null,
        "Could not parse upstream tools/list response"
      );
    }

    if (!parsed.rpc.result) parsed.rpc.result = {};
    const upstreamTools = Array.isArray(parsed.rpc.result.tools)
      ? parsed.rpc.result.tools
      : [];

    const localNames = new Set(LOCAL_TOOLS.map((tool) => tool.name));
    parsed.rpc.result.tools = [
      ...LOCAL_TOOLS,
      ...upstreamTools.filter((tool) => !localNames.has(tool?.name))
    ];
    parsed.rpc.result._meta = {
      ...(parsed.rpc.result._meta || {}),
      proxyVersion: PROXY_VERSION,
      localTools: LOCAL_TOOLS.map((tool) => tool.name)
    };

    return jsonRpcResponse(parsed.rpc, upstream.status);
  } catch (error) {
    return localToolsFallbackResponse(
      requestRpc?.id ?? null,
      error instanceof Error ? error.message : String(error)
    );
  }
}

function localToolsFallbackResponse(id, reason) {
  return jsonResponse({
    jsonrpc: "2.0",
    id,
    result: {
      tools: LOCAL_TOOLS,
      _meta: {
        proxyVersion: PROXY_VERSION,
        upstreamToolsUnavailable: true,
        reason: truncate(reason, 500)
      }
    }
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

    if (name === "upload_stitch_image_from_url") {
      const projectId = requireBareId(args.projectId, "projectId");
      const asset = await fetchRemoteUploadImage(args.url, env);
      const uploaded = await uploadImageToStitch(
        env,
        apiKey,
        projectId,
        bytesToBase64(asset.bytes),
        asset.mimeType,
        {
          title: args.title,
          createScreenInstances: args.createScreenInstances
        }
      );

      return rpcToolSuccess(id, [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              projectId,
              sourceUrl: asset.finalUrl,
              mimeType: asset.mimeType,
              bytes: asset.bytes.byteLength,
              ...uploaded
            },
            null,
            2
          )
        }
      ]);
    }

    if (name === "upload_stitch_image") {
      const projectId = requireBareId(args.projectId, "projectId");
      const mimeType = normalizeUploadMime(args.mimeType);
      const bytes = decodeAndValidateUploadBase64(
        args.fileContentBase64,
        mimeType,
        env
      );
      const uploaded = await uploadImageToStitch(
        env,
        apiKey,
        projectId,
        bytesToBase64(bytes),
        mimeType,
        {
          title: args.title,
          createScreenInstances: args.createScreenInstances
        }
      );

      return rpcToolSuccess(id, [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              projectId,
              mimeType,
              bytes: bytes.byteLength,
              ...uploaded
            },
            null,
            2
          )
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

async function fetchRemoteUploadImage(rawUrl, env) {
  const url = validatePublicHttpsUrl(rawUrl);
  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "image/png,image/jpeg,image/webp,image/*;q=0.8,*/*;q=0.2",
      "user-agent": "stitch-mcp-proxy/2.0"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(
      `Failed to download upload source image: HTTP ${response.status} ${response.statusText}`
    );
  }

  const contentTypeHeader = response.headers.get("content-type") || "";
  const declaredMime = normalizeUploadMime(
    contentTypeHeader.split(";")[0].trim().toLowerCase()
  );
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  enforceMaxImageBytes(bytes.byteLength, env);

  const detectedMime = detectUploadMime(bytes);
  if (!detectedMime) {
    throw new Error("Downloaded file is not a supported PNG, JPEG, or WEBP image.");
  }
  if (declaredMime !== detectedMime) {
    throw new Error(
      `Image MIME mismatch: server declared ${declaredMime}, bytes are ${detectedMime}.`
    );
  }

  return {
    requestedUrl: url.toString(),
    finalUrl: response.url || url.toString(),
    mimeType: detectedMime,
    bytes
  };
}

function validatePublicHttpsUrl(rawUrl) {
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

  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host === "metadata.google.internal" ||
    host === "169.254.169.254" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new Error(`Private or local image host is not allowed: ${host}`);
  }

  return url;
}

function normalizeUploadMime(mimeType) {
  switch ((mimeType || "").toLowerCase()) {
    case "image/png":
      return "image/png";
    case "image/jpeg":
    case "image/jpg":
      return "image/jpeg";
    case "image/webp":
      return "image/webp";
    default:
      throw new Error(
        `Unsupported image MIME type: ${mimeType || "unknown"}. Supported: image/png, image/jpeg, image/webp.`
      );
  }
}

function detectUploadMime(bytes) {
  if (isPng(bytes)) return "image/png";
  if (isJpeg(bytes)) return "image/jpeg";
  if (isWebp(bytes)) return "image/webp";
  return null;
}

function decodeAndValidateUploadBase64(value, mimeType, env) {
  if (!value || typeof value !== "string") {
    throw new Error("fileContentBase64 is required");
  }
  if (value.startsWith("data:")) {
    throw new Error(
      "fileContentBase64 must contain only base64 bytes, without a data: URL prefix."
    );
  }

  let bytes;
  try {
    bytes = base64ToBytes(value);
  } catch {
    throw new Error("fileContentBase64 is not valid base64");
  }

  enforceMaxImageBytes(bytes.byteLength, env);
  const detectedMime = detectUploadMime(bytes);
  if (!detectedMime) {
    throw new Error("Uploaded bytes are not a supported PNG, JPEG, or WEBP image.");
  }
  if (detectedMime !== mimeType) {
    throw new Error(
      `Image MIME mismatch: argument says ${mimeType}, bytes are ${detectedMime}.`
    );
  }
  return bytes;
}

function enforceMaxImageBytes(byteLength, env) {
  const maxBytes = Number(env.MAX_IMAGE_BYTES || DEFAULT_MAX_IMAGE_BYTES);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error("MAX_IMAGE_BYTES must be a positive number.");
  }
  if (byteLength > maxBytes) {
    throw new Error(
      `Image is too large (${byteLength} bytes). Limit is ${maxBytes} bytes.`
    );
  }
}

async function uploadImageToStitch(
  env,
  apiKey,
  projectId,
  fileContentBase64,
  mimeType,
  options = {}
) {
  const screen = {
    screenType: "IMAGE",
    isCreatedByClient: true,
    screenshot: {
      fileContentBase64,
      mimeType
    }
  };

  if (options.title) screen.title = String(options.title);

  const body = {
    parent: `projects/${projectId}`,
    requests: [{ screen }],
    createScreenInstances: options.createScreenInstances !== false
  };

  const endpoint =
    `${stitchApiBaseUrl(env)}/projects/${encodeURIComponent(projectId)}/screens:batchCreate`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify(body)
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      `Stitch image upload failed: HTTP ${response.status}: ${truncate(raw, 800)}`
    );
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `Stitch image upload returned non-JSON: ${truncate(raw, 800)}`
    );
  }

  const screens = Array.isArray(data?.results)
    ? data.results.map((result) => result?.screen).filter(Boolean)
    : [];

  return {
    screenCount: screens.length,
    screens,
    rawResponse: screens.length ? undefined : data
  };
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
  enforceMaxImageBytes(buffer.byteLength, env);

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
  const upstream = await fetchStitch(request, env, apiKey, rawBody);
  const headers = copyResponseHeaders(upstream.headers);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers
  });
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

function stitchApiBaseUrl(env) {
  return (env.STITCH_API_URL || DEFAULT_STITCH_API_URL).replace(/\/$/, "");
}

function getStitchApiKey(request, env) {
  return env.STITCH_API_KEY || request.headers.get("x-goog-api-key") || "";
}

function isBrowserNavigation(request) {
  const accept = (request.headers.get("accept") || "").toLowerCase();
  const secFetchMode = (
    request.headers.get("sec-fetch-mode") || ""
  ).toLowerCase();
  const secFetchDest = (
    request.headers.get("sec-fetch-dest") || ""
  ).toLowerCase();

  return (
    accept.includes("text/html") ||
    secFetchMode === "navigate" ||
    secFetchDest === "document"
  );
}

function isMcpPath(pathname) {
  return pathname === "/mcp" || /^\/mcp\/[^/]+\/?$/.test(pathname);
}

function configuredBridgeSecrets(env) {
  return [env.BRIDGE_KEY, env.PROXY_TOKEN]
    .filter((value) => typeof value === "string" && value.length > 0);
}

function pathTokenFromUrl(url) {
  const match = url.pathname.match(/^\/mcp\/([^/]+)\/?$/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function isAuthorized(request, env, requestUrl) {
  const secrets = configuredBridgeSecrets(env);
  if (!secrets.length) return true;

  const url = requestUrl instanceof URL ? requestUrl : new URL(request.url);
  const candidates = [];

  const pathToken = pathTokenFromUrl(url);
  if (pathToken) candidates.push(pathToken);

  const queryToken = url.searchParams.get("token");
  if (queryToken) candidates.push(queryToken);

  const direct = request.headers.get("x-bridge-key");
  if (direct) candidates.push(direct);

  const proxyToken = request.headers.get("x-proxy-token");
  if (proxyToken) candidates.push(proxyToken);

  const auth = request.headers.get("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]) candidates.push(match[1]);

  for (const candidate of candidates) {
    for (const secret of secrets) {
      if (timingSafeStringEqual(candidate, secret)) return true;
    }
  }

  return false;
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

async function parseJsonRpcResponse(
  response,
  timeoutMs = DEFAULT_UPSTREAM_RPC_TIMEOUT_MS
) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("text/event-stream")) {
    return parseSseJsonRpcResponse(response, timeoutMs);
  }

  const raw = await readResponseTextWithTimeout(response, timeoutMs);

  if (contentType.includes("application/json") || raw.trim().startsWith("{")) {
    try {
      return { rpc: JSON.parse(raw), raw };
    } catch {
      return { rpc: null, raw };
    }
  }

  if (raw.includes("data:")) {
    return { rpc: extractJsonRpcFromSseText(raw), raw };
  }

  return { rpc: null, raw };
}

async function parseSseJsonRpcResponse(response, timeoutMs) {
  if (!response.body) return { rpc: null, raw: "" };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Timed out waiting for Stitch SSE JSON-RPC response after ${timeoutMs}ms`
        );
      }

      const { value, done } = await withTimeout(
        reader.read(),
        remaining,
        "Timed out waiting for Stitch SSE chunk"
      );

      if (done) break;
      raw += decoder.decode(value, { stream: true });

      const rpc = extractJsonRpcFromSseText(raw);
      if (rpc) {
        try {
          await reader.cancel();
        } catch {
          // Ignore cancellation failures after receiving the JSON-RPC event.
        }
        return { rpc, raw };
      }

      if (raw.length > 2 * 1024 * 1024) {
        throw new Error("Stitch SSE response exceeded 2 MiB without a JSON-RPC event");
      }
    }

    raw += decoder.decode();
    return { rpc: extractJsonRpcFromSseText(raw), raw };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore.
    }
  }
}

function extractJsonRpcFromSseText(raw) {
  const events = String(raw || "").split(/\r?\n\r?\n/);

  for (const event of events) {
    const dataLines = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());

    if (!dataLines.length) continue;
    const data = dataLines.join("\n");

    try {
      const parsed = JSON.parse(data);
      if (parsed?.jsonrpc === "2.0") return parsed;
    } catch {
      // Event may be incomplete; keep reading.
    }
  }

  return null;
}

async function readResponseTextWithTimeout(response, timeoutMs) {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Timed out waiting for Stitch response body after ${timeoutMs}ms`
        );
      }

      const { value, done } = await withTimeout(
        reader.read(),
        remaining,
        "Timed out waiting for Stitch response chunk"
      );
      if (done) break;
      raw += decoder.decode(value, { stream: true });

      if (raw.length > 4 * 1024 * 1024) {
        throw new Error("Stitch JSON-RPC response exceeded 4 MiB");
      }
    }
    raw += decoder.decode();
    return raw;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore.
    }
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function jsonRpcResponse(rpc, status = 200) {
  return new Response(JSON.stringify(rpc), {
    status,
    headers: {
      ...corsHeaders(),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-stitch-proxy-version": PROXY_VERSION
    }
  });
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

function base64ToBytes(value) {
  const normalized = String(value).replace(/\s+/g, "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function copyResponseHeaders(source) {
  const headers = new Headers(source);
  headers.set("access-control-allow-origin", "*");
  headers.set(
    "access-control-expose-headers",
    "mcp-session-id, x-stitch-proxy-version"
  );
  headers.set("x-stitch-proxy-version", PROXY_VERSION);
  return headers;
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers":
      "Content-Type, Accept, Authorization, X-Bridge-Key, X-Proxy-Token, X-Goog-Api-Key, MCP-Session-Id, Last-Event-ID",
    "access-control-expose-headers":
      "MCP-Session-Id, X-Stitch-Proxy-Version",
    "x-stitch-proxy-version": PROXY_VERSION
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
