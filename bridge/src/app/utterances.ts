import { EventEmitter } from "node:events";
import type { DeviceHub, HubEvent } from "../device-hub.js";
import type { Listener } from "../mcp/dependencies.js";
import type { NotificationContext } from "../notify/context.js";
import type { Utterance } from "../stt/session.js";
import type { AppDevice } from "./device.js";

/** One fan-out for listen, Events and Slack; transcripts are never replayed. */
export class AppUtterances extends EventEmitter implements Listener {
  private readonly pending = new Set<() => void>();
  private closed = false;
  private readonly offline = () => { for (const finish of this.pending) finish(); };
  private readonly utterance = ({ deviceId, payload }: HubEvent<Utterance>) => {
    if (!this.device.isSelected(deviceId) || !payload.text.trim()) return;
    const startedAt = payload.started_at_ms;
    this.emit("utterance", { ...payload, ...this.context.forUtterance(startedAt) });
  };

  constructor(private readonly hub: DeviceHub, private readonly device: AppDevice, private readonly context: NotificationContext) {
    super();
    device.on("offline", this.offline);
    hub.on("utterance", this.utterance);
  }

  nextUtterance(timeoutMs: number): Promise<{ text: string } | null> {
    if (this.closed) return Promise.resolve(null);
    return new Promise(resolve => {
      const finish = (utterance: { text: string } | null = null) => {
        clearTimeout(timer);
        this.off("utterance", finish);
        this.pending.delete(cancel);
        resolve(utterance);
      };
      const cancel = () => finish();
      const timer = setTimeout(cancel, timeoutMs);
      this.pending.add(cancel);
      this.once("utterance", finish);
    });
  }

  dispose(): void {
    this.closed = true;
    this.device.off("offline", this.offline);
    this.hub.off("utterance", this.utterance);
    for (const finish of this.pending) finish();
    this.removeAllListeners();
  }
}
