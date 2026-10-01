import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import {
  createMcpHandler,
  McpServer,
  type ServerCapabilities,
} from "@modelcontextprotocol/server";
import { z } from "zod";

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT ?? "8790", 10);
const BASE_PATH = normalizeBasePath(process.env.BASE_PATH ?? "");
const endpointPaths = new Set([`${BASE_PATH}/mcp`, "/mcp"]);

const subscriptions = new Set<string>();

const EventListParams = z.object({}).passthrough();
const EventListResult = z.object({
  events: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      payloadSchema: z.record(z.string(), z.unknown()),
    }),
  ),
});
// The exact subscribe params ChatGPT sends are what this spike wants to learn,
// so accept anything and log only the key names (never the values).
const EventSubscribeParams = z.object({}).passthrough();
const EventSubscribeResult = z.object({ subscriptionId: z.string() });
const EventUnsubscribeParams = z.object({ subscriptionId: z.string() });
const EventUnsubscribeResult = z.object({ unsubscribed: z.boolean() });

type ExtendedCapabilities = ServerCapabilities & { events: Record<string, never> };

function timestamp(): string {
  return new Date().toISOString();
}

function logRequest(method: string, tool: string | undefined, status: number): void {
  console.log(
    JSON.stringify({ timestamp: timestamp(), method, ...(tool ? { tool } : {}), status }),
  );
}

function createServerInstance(): McpServer {
  const capabilities: ExtendedCapabilities = { events: {} };
  const server = new McpServer(
    { name: "dots-mcp-echo-spike", version: "0.0.0" },
    { capabilities },
  );

  server.registerTool(
    "echo",
    {
      description: "Return the supplied text unchanged.",
      inputSchema: z.object({ text: z.string().describe("Text to return unchanged.") }),
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );

  server.registerTool(
    "ring",
    {
      description: "Ring a test bell without changing external state.",
      inputSchema: z.object({ text: z.string().describe("Text whose length is logged.") }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ text }) => {
      console.log(`[ring] ${text.length} chars`);
      return { content: [{ type: "text", text: "rang" }] };
    },
  );

  server.server.setRequestHandler(
    "events/list",
    { params: EventListParams, result: EventListResult },
    async () => ({
      events: [
        {
          name: "spike.ping",
          description: "A test event used to inspect custom app event support.",
          payloadSchema: {
            type: "object",
            properties: { message: { type: "string" } },
          },
        },
      ],
    }),
  );

  server.server.setRequestHandler(
    "events/subscribe",
    { params: EventSubscribeParams, result: EventSubscribeResult },
    async (params) => {
      const subscriptionId = randomUUID();
      subscriptions.add(subscriptionId);
      console.log(
        `[events/subscribe] param keys=${Object.keys(params).sort().join(",")} subscription=${subscriptionId}`,
      );
      return { subscriptionId };
    },
  );

  server.server.setRequestHandler(
    "events/unsubscribe",
    { params: EventUnsubscribeParams, result: EventUnsubscribeResult },
    async ({ subscriptionId }) => ({ unsubscribed: subscriptions.delete(subscriptionId) }),
  );

  return server;
}

const mcpHandler = createMcpHandler(() => createServerInstance(), {
  legacy: "stateless",
  responseMode: "json",
  onerror: (error) => console.error(`[mcp/error] ${error.name}`),
});

const httpServer = createServer(async (req, res) => {
  const pathname = safePathname(req.url);
  if (!endpointPaths.has(pathname)) {
    sendText(res, 404, "Not found\n");
    return;
  }

  let body: Uint8Array;
  try {
    body = await readBody(req);
  } catch (error) {
    sendText(res, 400, "Invalid request body\n");
    logRequest("unknown", undefined, 400);
    return;
  }

  const { method, tool } = inspectMessage(body);
  try {
    const request = toWebRequest(req, body);
    const response = await mcpHandler.fetch(request);
    await sendWebResponse(res, response);
    logRequest(method, tool, response.status);
  } catch (error) {
    console.error(`[http/error] ${error instanceof Error ? error.name : "unknown error"}`);
    sendText(res, 500, "Internal server error\n");
    logRequest(method, tool, 500);
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(`MCP echo spike listening on http://${HOST}:${PORT}${BASE_PATH}/mcp`);
  if (BASE_PATH) {
    console.log("Also accepting /mcp because Tailscale Funnel --set-path strips its mount path.");
  }
});

async function shutdown(): Promise<void> {
  await mcpHandler.close();
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

function normalizeBasePath(value: string): string {
  if (!value || value === "/") return "";
  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

function safePathname(rawUrl: string | undefined): string {
  try {
    return new URL(rawUrl ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function inspectMessage(body: Uint8Array): { method: string; tool?: string } {
  try {
    const value = JSON.parse(Buffer.from(body).toString("utf8")) as {
      method?: unknown;
      params?: { name?: unknown };
    };
    return {
      method: typeof value.method === "string" ? value.method : "unknown",
      ...(typeof value.params?.name === "string" ? { tool: value.params.name } : {}),
    };
  } catch {
    return { method: "unknown" };
  }
}

function toWebRequest(req: IncomingMessage, body: Uint8Array): Request {
  const method = req.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const path = req.url ?? "/mcp";
  return new Request(`http://${HOST}:${PORT}${path}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : new Uint8Array(body),
  });
}

async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}
