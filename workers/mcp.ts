/**
 * Standalone MCP entry point. It owns no product bindings and creates a fresh
 * `/v1` client for each protocol request, so caller credentials cannot cross
 * request boundaries in a reused Worker isolate.
 */
import { McpServer, type McpRequestContext } from "@modelcontextprotocol/server";
import { createMcpHandler, type StatelessMcpHandler } from "agents/mcp/server";

/*
 * Relative, not the `~/…` alias the rest of the repo uses. That alias is
 * declared in tsconfig.cloudflare.json, and the product Worker resolves it only
 * because Vite applies it during the react-router build. This Worker is bundled
 * by `wrangler deploy` straight through esbuild, which reads the root
 * tsconfig.json — where `paths` is absent, because the root is a solution file
 * holding project references. `~/lib/mcp/client` therefore typechecks and then
 * fails to bundle. A relative path is resolved identically by both.
 */
import { CallboardClient } from "../app/lib/mcp/client";
import { CALLBOARD_TOOLS } from "../app/lib/mcp/tools";

export interface McpEnv {
  APP_ORIGIN?: string;
  CALLBOARD_API_KEY?: string;
}

const SERVER_NAME = "callboard";
const SERVER_VERSION = "1.0.0";
const DEFAULT_ORIGIN = "https://demo.callboardhq.com";

interface ResolvedConfig {
  origin: string;
  fallbackApiKey: string | null;
}

interface CachedHandler extends ResolvedConfig {
  handler: StatelessMcpHandler;
}

/*
 * Worker vars and secrets are immutable for an isolate's lifetime. The first
 * request captures that static configuration; later requests must match it.
 * Caller keys are deliberately excluded from this cache and are read from the
 * factory's original Request every time, which is the concurrency-sensitive
 * value.
 */
let cachedHandler: CachedHandler | undefined;

function resolveConfig(env: McpEnv): ResolvedConfig {
  const configured = env.APP_ORIGIN?.trim() || DEFAULT_ORIGIN;
  const parsed = new URL(configured);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("APP_ORIGIN must be an HTTPS origin with no path, query, or credentials.");
  }
  return {
    origin: parsed.origin,
    fallbackApiKey: env.CALLBOARD_API_KEY?.trim() || null,
  };
}

function presentedApiKey(request: Request | undefined, fallback: string | null): string | null {
  const direct = request?.headers.get("x-access-token")?.trim();
  if (direct) return direct;
  const authorization = request?.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return bearer || fallback;
}

function buildHandler(config: ResolvedConfig): StatelessMcpHandler {
  return createMcpHandler(
    (requestContext: McpRequestContext) => {
      const client = new CallboardClient({
        origin: config.origin,
        apiKey: presentedApiKey(requestContext.requestInfo, config.fallbackApiKey),
      });
      const server = new McpServer(
        { name: SERVER_NAME, version: SERVER_VERSION },
        {
          instructions:
            "Call list_events when you need an event id. Abstracts and programme sessions are one REST resource split by is_abstract. Call get_openapi to discover the deeper public REST API.",
        },
      );

      for (const tool of CALLBOARD_TOOLS) {
        server.registerTool(
          tool.name,
          {
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
          },
          async (input) => tool.handler(input as Record<string, unknown>, { client }),
        );
      }
      return server;
    },
    {
      route: "/mcp",
      onerror(error: Error) {
        console.error("Callboard MCP transport error", error);
      },
    },
  );
}

function handlerFor(config: ResolvedConfig): StatelessMcpHandler {
  if (!cachedHandler) {
    cachedHandler = { ...config, handler: buildHandler(config) };
  } else if (
    cachedHandler.origin !== config.origin ||
    cachedHandler.fallbackApiKey !== config.fallbackApiKey
  ) {
    throw new Error("MCP Worker configuration changed inside one isolate.");
  }
  return cachedHandler.handler;
}

function descriptor(origin: string): Response {
  return new Response(
    JSON.stringify({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      endpoint: "/mcp",
      upstream_origin: origin,
      tools: CALLBOARD_TOOLS.map((tool) => tool.name),
      hint: "Send your Callboard API key as x-access-token.",
    }),
    { headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

export default {
  async fetch(request: Request, env: McpEnv, ctx: ExecutionContext): Promise<Response> {
    const config = resolveConfig(env);
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return descriptor(config.origin);
    }
    return handlerFor(config)(request, env, ctx);
  },
};
