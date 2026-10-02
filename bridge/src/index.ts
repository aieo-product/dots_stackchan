import { readVoiceConfig, selectVoiceMode } from "./speech/config.js";
import { openAiPcmSource } from "./speech/openai-tts.js";
import { SpeechQueue } from "./speech/queue.js";
import { ProtocolSpeaker, type DeviceTransport } from "./speech/speaker.js";

export { SpeechQueue } from "./speech/queue.js";
export type { DeviceTransport, Speaker, Utterance } from "./speech/speaker.js";

// The device gateway calls this after hello and routes tts.done to onDone.
// Create one queue per device session, and cancel it on disconnect.
export async function createSpeechQueue(transport: DeviceTransport, caps: { sanotts: boolean },
  env: NodeJS.ProcessEnv = process.env): Promise<SpeechQueue> {
  const config = readVoiceConfig(env);
  await transport.sendText({ type: "voice.mode", mode: selectVoiceMode(config, caps.sanotts, "ja") });
  return new SpeechQueue(new ProtocolSpeaker(transport,
    (utterance) => selectVoiceMode(config, caps.sanotts, utterance.language),
    openAiPcmSource(config, env.OPENAI_API_KEY ?? "")));
}
