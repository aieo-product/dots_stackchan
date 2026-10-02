import { EventEmitter } from "node:events";
import type { DeviceHub, HubEvent } from "../device-hub.js";
import { bridgeToDeviceMessageSchema, type DeviceToBridgeMessage } from "../protocol.js";
import type { DeviceLink, DeviceMessage } from "../tts/types.js";

/** First authenticated hello wins until disconnect. No jobs migrate between devices. */
export class AppDevice extends EventEmitter implements DeviceLink {
  private selected?: string;
  private readonly bindings: Array<[string, (event: HubEvent<DeviceToBridgeMessage>) => void]> = [];

  constructor(private readonly hub: DeviceHub) {
    super();
    for (const name of ["online", "hello", "state", "event", "tts.done", "mic.start", "mic.end", "offline"]) {
      const listener = (event: HubEvent<DeviceToBridgeMessage>) => {
        if (name === "online") {
          if (this.isSelected(event.deviceId)) {
            this.emit("offline");
            this.selected = undefined;
          }
          return;
        }
        if (name === "hello" && !this.selected) {
          this.selected = event.deviceId;
          this.emit("connected");
        }
        if (!this.isSelected(event.deviceId)) return;
        if (name === "offline") {
          this.emit("offline");
          this.selected = undefined;
          // Prefer the first remaining device whose hello has already arrived.
          const next = hub.listDevices().find(device => device.presence === "online" && device.fw);
          if (next) {
            this.selected = next.deviceId;
            this.emit("connected");
            this.emit("message", { type: "hello" });
          }
        } else this.emit("message", event.payload);
      };
      hub.on(name, listener);
      this.bindings.push([name, listener]);
    }
  }

  isSelected(deviceId: string): boolean { return deviceId === this.selected; }
  get online(): boolean { return this.selected !== undefined && this.hub.getDevice(this.selected).presence === "online"; }
  get caps() { return this.selected ? this.hub.getDevice(this.selected).caps ?? emptyCaps() : emptyCaps(); }
  get state() { return this.selected ? this.hub.getDevice(this.selected).state : undefined; }
  send(message: DeviceMessage): void {
    // TTS carries internal engine metadata. Keep v1 wire messages strict.
    const wire = { ...message };
    delete wire.engine;
    delete wire.voice_mode;
    const parsed = bridgeToDeviceMessageSchema.parse(wire);
    if (!this.selected || !this.hub.send(this.selected, parsed)) throw new Error("Device is offline");
  }
  sendBinary(kind: number, seq: number, data: Uint8Array): void {
    if (kind !== 0x02) throw new Error("Only TTS PCM can be sent to a device");
    if (!this.selected || !this.hub.sendBinary(this.selected, seq, data)) throw new Error("Device is offline");
  }
  dispose(): void {
    for (const [name, listener] of this.bindings) this.hub.off(name, listener);
    this.removeAllListeners();
    this.selected = undefined;
  }
}

function emptyCaps() { return { sanotts: false, servo: false, mic: false }; }
