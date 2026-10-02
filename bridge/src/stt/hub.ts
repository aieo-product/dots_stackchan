import type { DeviceHub, HubEvent } from "../device-hub.js";
import type { Logger } from "../log.js";
import type { BinaryFrame, DeviceToBridgeMessage } from "../protocol.js";
import type { SttEngine } from "./engine.js";
import { SttSession, type Utterance } from "./session.js";

export interface SttHubOptions {
  createEngine: () => SttEngine;
  logTranscripts?: boolean;
}

/** Owns one session per connected device; reconnect/shutdown always disposes it. */
export function attachStt(hub: DeviceHub, options: SttHubOptions, logger: Logger): () => void {
  const sessions = new Map<string, SttSession>();
  const remove = ({ deviceId }: HubEvent<unknown>): void => {
    sessions.get(deviceId)?.close();
    sessions.delete(deviceId);
  };
  const online = (event: HubEvent<unknown>): void => {
    remove(event);
    const session = new SttSession(options.createEngine(), { logger, logTranscripts: options.logTranscripts });
    sessions.set(event.deviceId, session);
    session.on("utterance", (payload: Utterance) => hub.emit("utterance", { deviceId: event.deviceId, payload }));
    session.on("partial", (payload: { seq: number; delta: string }) => hub.emit("stt.partial", { deviceId: event.deviceId, payload }));
    session.prepare();
  };
  const start = ({ deviceId, payload }: HubEvent<Extract<DeviceToBridgeMessage, { type: "mic.start" }>>): void => {
    const state = hub.getStatus(deviceId).state;
    if (state === "speaking" || state === "notifying") { logger.warn("stt_rejected", { reason: "device_playing" }); return; }
    sessions.get(deviceId)?.start(payload.seq);
  };
  const data = ({ deviceId, payload }: HubEvent<BinaryFrame>): void => sessions.get(deviceId)?.push(payload.seq, payload.data);
  const end = ({ deviceId, payload }: HubEvent<Extract<DeviceToBridgeMessage, { type: "mic.end" }>>): void => sessions.get(deviceId)?.end(payload.seq);
  hub.on("online", online);
  hub.on("offline", remove);
  hub.on("mic.start", start);
  hub.on("mic.data", data);
  hub.on("mic.end", end);
  return () => {
    hub.off("online", online);
    hub.off("offline", remove);
    hub.off("mic.start", start);
    hub.off("mic.data", data);
    hub.off("mic.end", end);
    for (const session of sessions.values()) session.close();
    sessions.clear();
  };
}
