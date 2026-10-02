import { EventEmitter } from "node:events";
import WebSocket, { type RawData } from "ws";

import type { Logger } from "./log.js";
import {
  BinaryKind,
  bridgeToDeviceMessageSchema,
  decodeBinaryFrame,
  deviceToBridgeMessageSchema,
  encodeBinaryFrame,
  isUnknownDeviceMessage,
  type BridgeToDeviceMessage,
  type DeviceCapabilities,
  type DeviceState,
  type DeviceToBridgeMessage,
} from "./protocol.js";

interface DeviceConnection {
  socket: WebSocket;
  session: string;
  alive: boolean;
}

export interface HubEvent<T> {
  deviceId: string;
  payload: T;
}

export interface DeviceStatus {
  presence: "online" | "offline";
  state?: DeviceState;
  caps?: DeviceCapabilities;
  fw?: string;
}

function rawDataToBytes(raw: RawData): Uint8Array {
  if (Array.isArray(raw)) return new Uint8Array(Buffer.concat(raw));
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

export class DeviceHub extends EventEmitter {
  private readonly connections = new Map<string, DeviceConnection>();
  private readonly statuses = new Map<string, DeviceStatus>();
  private heartbeatTimer?: NodeJS.Timeout;

  public constructor(private readonly logger: Logger) {
    super();
  }

  public connect(deviceId: string, socket: WebSocket, session: string): void {
    const previous = this.connections.get(deviceId);
    if (previous !== undefined && previous.socket !== socket) previous.socket.close(4000, "replaced");

    const connection: DeviceConnection = { socket, session, alive: true };
    this.connections.set(deviceId, connection);
    const caps = this.statuses.get(deviceId)?.caps;
    this.statuses.set(deviceId, { presence: "online", ...(caps === undefined ? {} : { caps }) });
    this.emit("online", { deviceId, payload: { session } } satisfies HubEvent<{ session: string }>);
    this.logger.info("device_online", { device_id: deviceId });

    socket.on("pong", () => {
      connection.alive = true;
    });
    socket.on("message", (data, isBinary) => this.handleFrame(deviceId, socket, data, isBinary));
    socket.once("close", () => this.disconnect(deviceId, socket));
    socket.on("error", (error) => this.logger.warn("device_socket_error", { device_id: deviceId, message: error.message }));
  }

  public send(deviceId: string, message: BridgeToDeviceMessage): boolean {
    const parsed = bridgeToDeviceMessageSchema.safeParse(message);
    if (!parsed.success) throw new Error(`Invalid bridge message: ${parsed.error.message}`);
    const connection = this.connections.get(deviceId);
    if (connection === undefined || connection.socket.readyState !== WebSocket.OPEN) return false;
    connection.socket.send(JSON.stringify(parsed.data));
    return true;
  }

  public sendBinary(deviceId: string, seq: number, data: Uint8Array): boolean {
    const connection = this.connections.get(deviceId);
    if (connection === undefined || connection.socket.readyState !== WebSocket.OPEN) return false;
    connection.socket.send(encodeBinaryFrame(BinaryKind.ttsPcm, seq, data), { binary: true });
    return true;
  }

  public getStatus(deviceId: string): DeviceStatus {
    return this.getDevice(deviceId);
  }

  public getDevice(deviceId: string): DeviceStatus {
    const status = this.statuses.get(deviceId) ?? { presence: "offline" };
    return { ...status, ...(status.caps === undefined ? {} : { caps: { ...status.caps } }) };
  }

  public listDevices(): Array<DeviceStatus & { deviceId: string }> {
    return [...this.statuses.keys()].map((deviceId) => ({ deviceId, ...this.getDevice(deviceId) }));
  }

  public connectedDeviceCount(): number {
    return this.connections.size;
  }

  public startHeartbeat(intervalMilliseconds: number): void {
    if (this.heartbeatTimer !== undefined) return;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), intervalMilliseconds);
    this.heartbeatTimer.unref();
  }

  public stopHeartbeat(): void {
    if (this.heartbeatTimer === undefined) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  public close(): void {
    this.stopHeartbeat();
    for (const connection of this.connections.values()) connection.socket.close(1001, "server_shutdown");
  }

  private disconnect(deviceId: string, socket: WebSocket): void {
    const current = this.connections.get(deviceId);
    if (current?.socket !== socket) return;
    this.connections.delete(deviceId);
    const caps = this.statuses.get(deviceId)?.caps;
    this.statuses.set(deviceId, { presence: "offline", ...(caps === undefined ? {} : { caps }) });
    this.emit("offline", { deviceId, payload: {} } satisfies HubEvent<Record<string, never>>);
    this.logger.info("device_offline", { device_id: deviceId });
  }

  private heartbeat(): void {
    for (const [deviceId, connection] of this.connections) {
      if (!connection.alive) {
        this.logger.warn("heartbeat_timeout", { device_id: deviceId });
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
  }

  private handleFrame(deviceId: string, socket: WebSocket, raw: RawData, isBinary: boolean): void {
    if (this.connections.get(deviceId)?.socket !== socket) return;
    if (isBinary) {
      try {
        const frame = decodeBinaryFrame(rawDataToBytes(raw));
        if (frame.kind !== BinaryKind.microphonePcm) throw new Error("Device binary frame must contain microphone PCM");
        this.emit("mic.data", { deviceId, payload: frame } satisfies HubEvent<typeof frame>);
      } catch (error: unknown) {
        this.logger.warn("invalid_binary_frame", {
          device_id: deviceId,
          message: error instanceof Error ? error.message : "Unknown binary frame error",
        });
      }
      return;
    }

    let candidate: unknown;
    try {
      candidate = JSON.parse(raw.toString());
    } catch {
      this.logger.warn("invalid_json_message", { device_id: deviceId });
      return;
    }
    const result = deviceToBridgeMessageSchema.safeParse(candidate);
    if (!result.success) {
      if (isUnknownDeviceMessage(candidate)) {
        this.logger.debug("unknown_device_message", { device_id: deviceId });
        return;
      }
      this.logger.warn("invalid_device_message", { device_id: deviceId });
      return;
    }
    this.handleMessage(deviceId, result.data);
  }

  private handleMessage(deviceId: string, message: DeviceToBridgeMessage): void {
    switch (message.type) {
      case "hello": {
        this.statuses.set(deviceId, {
          ...this.statuses.get(deviceId), presence: "online", caps: message.caps, fw: message.fw,
        });
        const session = this.connections.get(deviceId)?.session;
        if (session !== undefined) {
          this.send(deviceId, { type: "welcome", session, server_time: Math.floor(Date.now() / 1_000) });
        }
        this.emit("hello", { deviceId, payload: message } satisfies HubEvent<typeof message>);
        break;
      }
      case "ping":
        this.send(deviceId, { type: "pong", t: message.t });
        break;
      case "pong":
        break;
      case "state":
        this.statuses.set(deviceId, { ...this.statuses.get(deviceId), presence: "online", state: message.state });
        this.emit("state", { deviceId, payload: message } satisfies HubEvent<typeof message>);
        break;
      case "event":
        this.emit("event", { deviceId, payload: message } satisfies HubEvent<typeof message>);
        this.emit(message.kind, { deviceId, payload: message } satisfies HubEvent<typeof message>);
        break;
      case "mic.start":
      case "mic.end":
      case "tts.done":
        this.emit(message.type, { deviceId, payload: message } satisfies HubEvent<typeof message>);
        break;
    }
  }
}
