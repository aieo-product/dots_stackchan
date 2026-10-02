import { z } from "zod";

const sequence = z.number().int().min(0).max(65_535);

export const helloSchema = z.object({
  type: z.literal("hello"),
  fw: z.string().min(1),
  caps: z.object({
    sanotts: z.boolean(),
    servo: z.boolean(),
    mic: z.boolean(),
  }),
});

export const welcomeSchema = z.strictObject({
  type: z.literal("welcome"),
  session: z.string().min(1),
  server_time: z.number().int().nonnegative(),
});

export const stateSchema = z.object({
  type: z.literal("state"),
  state: z.enum(["idle", "listening", "thinking", "speaking", "notifying"]),
});

export const eventSchema = z.object({
  type: z.literal("event"),
  kind: z.enum(["touch", "button"]),
  where: z.string().min(1).optional(),
});

export const micStartSchema = z.object({
  type: z.literal("mic.start"),
  seq: sequence,
  sample_rate: z.literal(16_000),
});

export const micEndSchema = z.object({
  type: z.literal("mic.end"),
  seq: sequence,
  reason: z.enum(["release", "timeout", "vad"]),
});

export const faceSchema = z.strictObject({
  type: z.literal("face"),
  expression: z.enum(["neutral", "happy", "sad", "doubt", "sleepy", "angry"]),
});

export const lookSchema = z.strictObject({
  type: z.literal("look"),
  pan: z.number(),
  tilt: z.number(),
});

export const speakKanaSchema = z.strictObject({
  type: z.literal("speak.kana"),
  seq: sequence,
  kana: z.string().min(1),
  expression: faceSchema.shape.expression.optional(),
});

export const ttsStartSchema = z.strictObject({
  type: z.literal("tts.start"),
  seq: sequence,
  sample_rate: z.number().int().positive(),
  channels: z.literal(1),
  bits: z.literal(16),
});

export const ttsEndSchema = z.strictObject({
  type: z.literal("tts.end"),
  seq: sequence,
});

export const ttsCancelSchema = z.strictObject({
  type: z.literal("tts.cancel"),
});

export const ttsDoneSchema = z.object({
  type: z.literal("tts.done"),
  seq: sequence,
  ok: z.boolean(),
});

export const chimeSchema = z.strictObject({
  type: z.literal("chime"),
  kind: z.literal("notify"),
});

export const pingSchema = z.strictObject({
  type: z.literal("ping"),
  t: z.number(),
});

export const pongSchema = z.strictObject({
  type: z.literal("pong"),
  t: z.number(),
});

export const deviceToBridgeMessageSchema = z.discriminatedUnion("type", [
  helloSchema,
  stateSchema,
  eventSchema,
  micStartSchema,
  micEndSchema,
  ttsDoneSchema,
  pingSchema.strip(),
  pongSchema.strip(),
]);

const deviceMessageEnvelopeSchema = z.object({ type: z.string() });

export function isUnknownDeviceMessage(value: unknown): boolean {
  const envelope = deviceMessageEnvelopeSchema.safeParse(value);
  return envelope.success && !deviceToBridgeMessageSchema.options.some(
    (schema) => schema.shape.type.value === envelope.data.type,
  );
}

export const bridgeToDeviceMessageSchema = z.discriminatedUnion("type", [
  welcomeSchema,
  faceSchema,
  lookSchema,
  speakKanaSchema,
  ttsStartSchema,
  ttsEndSchema,
  ttsCancelSchema,
  chimeSchema,
  pingSchema,
  pongSchema,
]);

export type DeviceToBridgeMessage = z.infer<typeof deviceToBridgeMessageSchema>;
export type BridgeToDeviceMessage = z.infer<typeof bridgeToDeviceMessageSchema>;
export type DeviceState = z.infer<typeof stateSchema>["state"];
export type DeviceCapabilities = z.infer<typeof helloSchema>["caps"];

export const BINARY_HEADER_BYTES = 3;
export const MAX_BINARY_FRAME_BYTES = 4_096;
export const BinaryKind = {
  microphonePcm: 0x01,
  ttsPcm: 0x02,
} as const;
export type BinaryKind = (typeof BinaryKind)[keyof typeof BinaryKind];

export interface BinaryFrame {
  kind: BinaryKind;
  seq: number;
  data: Uint8Array;
}

export function encodeBinaryFrame(kind: BinaryKind, seq: number, data: Uint8Array): Uint8Array {
  if (kind !== BinaryKind.microphonePcm && kind !== BinaryKind.ttsPcm) {
    throw new Error("Unknown binary frame kind");
  }
  if (!Number.isInteger(seq) || seq < 0 || seq > 65_535) {
    throw new Error("Binary frame sequence must be an unsigned 16-bit integer");
  }
  if (data.byteLength + BINARY_HEADER_BYTES > MAX_BINARY_FRAME_BYTES) {
    throw new Error(`Binary frame must not exceed ${MAX_BINARY_FRAME_BYTES} bytes`);
  }

  const frame = new Uint8Array(BINARY_HEADER_BYTES + data.byteLength);
  frame[0] = kind;
  new DataView(frame.buffer).setUint16(1, seq, true);
  frame.set(data, BINARY_HEADER_BYTES);
  return frame;
}

export function decodeBinaryFrame(frame: Uint8Array): BinaryFrame {
  if (frame.byteLength < BINARY_HEADER_BYTES || frame.byteLength > MAX_BINARY_FRAME_BYTES) {
    throw new Error(`Binary frame size must be ${BINARY_HEADER_BYTES}..${MAX_BINARY_FRAME_BYTES} bytes`);
  }
  const kind = frame[0];
  if (kind !== BinaryKind.microphonePcm && kind !== BinaryKind.ttsPcm) {
    throw new Error("Unknown binary frame kind");
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return {
    kind,
    seq: view.getUint16(1, true),
    data: frame.slice(BINARY_HEADER_BYTES),
  };
}
