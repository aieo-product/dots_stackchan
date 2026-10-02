import type { DeviceHub, HubEvent } from "../device-hub.js";
import type { SourceEvent } from "../events/catalog.js";
import type { EventSource } from "../events/dispatcher.js";
import type { Utterance } from "../slack/contracts.js";
import type { AppDevice } from "./device.js";
import type { AppUtterances } from "./utterances.js";

export function appEventSource(hub: DeviceHub, device: AppDevice, utterances: AppUtterances, route: "mcp" | "slack" | "both"): EventSource {
  return {
    subscribe(callback: (event: SourceEvent) => void) {
      const heard = (utterance: Utterance & { duration_ms: number }) => {
        if (route === "slack") return;
        callback({ name: "stackchan.utterance", data: {
          text: utterance.text, lang: utterance.lang, duration_ms: utterance.duration_ms,
          ...(utterance.reply_to ? { reply_to: utterance.reply_to } : {}),
        } });
      };
      const touch = ({ deviceId, payload }: HubEvent<{ kind: string; where?: string }>) => {
        if (!device.isSelected(deviceId) || payload.kind !== "touch") return;
        callback({ name: "stackchan.touched", data: { where: (payload.where ?? "screen").slice(0, 128) } });
      };
      const online = () => callback({ name: "stackchan.online_changed", data: { online: true } });
      const offline = () => callback({ name: "stackchan.online_changed", data: { online: false } });
      utterances.on("utterance", heard);
      hub.on("event", touch);
      device.on("connected", online);
      device.on("offline", offline);
      return () => {
        utterances.off("utterance", heard);
        hub.off("event", touch);
        device.off("connected", online);
        device.off("offline", offline);
      };
    },
  };
}
