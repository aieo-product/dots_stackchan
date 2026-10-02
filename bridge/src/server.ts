import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";

import { ReplayCache, verifyDeviceAuth } from "./auth.js";
import { DeviceHub } from "./device-hub.js";
import type { Logger } from "./log.js";

export interface BridgeServerOptions {
  host: string;
  port: number;
  psk: string;
  logger: Logger;
  heartbeatIntervalMs?: number;
}

export interface ListeningAddress {
  host: string;
  port: number;
}

export interface BridgeServer {
  hub: DeviceHub;
  listen(): Promise<ListeningAddress>;
  close(): Promise<void>;
}

function rejectUpgrade(socket: Duplex, status: 401 | 404): void {
  const label = status === 401 ? "Unauthorized" : "Not Found";
  socket.end(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function createBridgeServer(options: BridgeServerOptions): BridgeServer {
  const hub = new DeviceHub(options.logger);
  const replayCache = new ReplayCache();
  const webSockets = new WebSocketServer({ noServer: true });
  const httpServer: HttpServer = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", devices: hub.connectedDeviceCount() }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });

  httpServer.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/device") {
      rejectUpgrade(socket, 404);
      return;
    }
    const auth = verifyDeviceAuth(request.headers, options.psk, Math.floor(Date.now() / 1_000), replayCache);
    if (!auth.ok) {
      options.logger.warn("auth_rejected", { device_id: auth.deviceId, reason: auth.reason });
      rejectUpgrade(socket, 401);
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      hub.connect(auth.deviceId, webSocket, randomUUID());
    });
  });

  return {
    hub,
    listen: () =>
      new Promise((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        httpServer.once("error", onError);
        httpServer.listen(options.port, options.host, () => {
          httpServer.off("error", onError);
          const address = httpServer.address() as AddressInfo;
          hub.startHeartbeat(options.heartbeatIntervalMs ?? 20_000);
          resolve({ host: options.host, port: address.port });
        });
      }),
    close: async () => {
      hub.close();
      await new Promise<void>((resolve, reject) => {
        webSockets.close(() => {
          httpServer.close((error) => (error === undefined ? resolve() : reject(error)));
        });
      });
    },
  };
}
