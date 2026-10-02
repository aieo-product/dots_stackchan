import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

import { wrapMcpHandler, type OAuth } from "../oauth/index.js";

import {
  createMcpToolRegistrar,
  type McpToolDependencies,
} from "./tools.js";

const DEFAULT_HOST = "127.0.0.1";

export interface McpServerAddress {
  readonly host: string;
  readonly port: number;
}

export interface McpHttpServer {
  listen(port: number, host?: string): Promise<McpServerAddress>;
  close(): Promise<void>;
}

export function createMcpServer(
  dependencies: McpToolDependencies,
  options: { readonly oauth?: OAuth } = {},
): McpHttpServer {
  const tools = createMcpToolRegistrar(dependencies);
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: "dots-stackchan", version: "0.0.0" });
      tools.register(server);
      return server;
    },
    {
      legacy: "stateless",
      responseMode: "json",
    },
  );
  const fetchHandler = options.oauth ? wrapMcpHandler(options.oauth, handler.fetch) : handler.fetch;
  let httpServer: HttpServer | undefined;

  return {
    async listen(port, host = DEFAULT_HOST): Promise<McpServerAddress> {
      if (httpServer !== undefined) {
        throw new Error("The MCP server is already listening.");
      }

      const server = createHttpServer({ requestTimeout: 30_000, headersTimeout: 30_000, keepAliveTimeout: 5_000 }, (request, response) => {
        void handleRequest(request, response, fetchHandler, host, port, options.oauth !== undefined);
      });
      httpServer = server;

      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => reject(error);
          server.once("error", onError);
          server.listen(port, host, () => {
            server.off("error", onError);
            resolve();
          });
        });
      } catch (error) {
        httpServer = undefined;
        throw error;
      }

      const address = server.address();
      if (address === null || typeof address === "string") {
        await closeHttpServer(server);
        httpServer = undefined;
        throw new Error("The MCP server did not receive a TCP address.");
      }
      return { host, port: address.port };
    },

    async close(): Promise<void> {
      const server = httpServer;
      httpServer = undefined;
      if (server !== undefined) await closeHttpServer(server);
      await handler.close();
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  fetchHandler: (request: Request) => Promise<Response>,
  host: string,
  port: number,
  publicSurface: boolean,
): Promise<void> {
  if (!publicSurface && safePathname(request.url) !== "/mcp") {
    sendText(response, 404, "Not found\n");
    return;
  }

  try {
    const body = await readBody(request);
    const webRequest = toWebRequest(request, body, host, port);
    const webResponse = await fetchHandler(webRequest);
    await sendWebResponse(response, webResponse);
  } catch (error) {
    if (!response.headersSent) {
      response.setHeader("connection", "close");
      sendText(response, error instanceof BodyTooLargeError ? 413 : 500,
        error instanceof BodyTooLargeError ? "Request too large\n" : "Internal server error\n");
    } else {
      response.end();
    }
  }
}

function safePathname(rawUrl: string | undefined): string {
  try {
    return new URL(rawUrl ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

class BodyTooLargeError extends Error {}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk as Uint8Array;
    size += bytes.byteLength;
    if (size > 65_536) throw new BodyTooLargeError();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function toWebRequest(
  request: IncomingMessage,
  body: Uint8Array,
  host: string,
  port: number,
): Request {
  const method = request.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  return new Request(`http://${host}:${port}${request.url ?? "/mcp"}`, {
    method,
    headers,
    body:
      method === "GET" || method === "HEAD" ? undefined : new Uint8Array(body),
  });
}

async function sendWebResponse(
  response: ServerResponse,
  webResponse: Response,
): Promise<void> {
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, name) => response.setHeader(name, value));
  response.end(Buffer.from(await webResponse.arrayBuffer()));
}

function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(text);
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
