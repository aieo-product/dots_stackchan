import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  createNotificationCenter,
  type NotificationCenter,
} from "../notify/center.js";
import {
  EXPRESSIONS,
  type DeviceLink,
  type Listener,
  type Speaker,
} from "./dependencies.js";
import {
  SlidingWindowRateLimiter,
  type RateLimitPolicy,
} from "./rate-limit.js";

const DEFAULT_RATE_LIMIT: RateLimitPolicy = {
  maxCalls: 20,
  windowMs: 60_000,
};
const DEFAULT_LISTEN_TIMEOUT_SECONDS = 30;
const MAX_SPEECH_WAIT_MS = 60_000;

export interface McpToolDependencies {
  readonly device: DeviceLink;
  readonly speaker: Speaker;
  readonly listener: Listener;
  readonly notificationCenter?: NotificationCenter;
  readonly now?: () => number;
  readonly rateLimits?: Partial<Record<"say" | "notify", RateLimitPolicy>>;
}

interface StatusSnapshot {
  readonly online: boolean;
  readonly speaking: boolean;
  readonly listening: boolean;
  readonly last_utterance_seconds_ago: number | null;
}

export function createMcpToolRegistrar(dependencies: McpToolDependencies): {
  register(server: McpServer): void;
} {
  const now = dependencies.now ?? Date.now;
  const rateLimiter = new SlidingWindowRateLimiter(now);
  const notificationCenter =
    dependencies.notificationCenter ??
    createNotificationCenter({
      device: dependencies.device,
      speaker: dependencies.speaker,
    });
  let deviceState: string | undefined;
  let activeSpeech = 0;
  let activeListeners = 0;
  let lastUtteranceAt: number | undefined;

  dependencies.device.on("message", (message) => {
    if (
      isRecord(message) &&
      message.type === "state" &&
      typeof message.state === "string"
    ) {
      deviceState = message.state;
    }
  });

  function status(): StatusSnapshot {
    return {
      online: dependencies.device.online,
      speaking: activeSpeech > 0 || deviceState === "speaking",
      listening: activeListeners > 0 || deviceState === "listening",
      last_utterance_seconds_ago:
        lastUtteranceAt === undefined
          ? null
          : Math.max(0, Math.floor((now() - lastUtteranceAt) / 1_000)),
    };
  }

  function rateLimit(tool: "say" | "notify"): CallToolResult | undefined {
    const result = rateLimiter.tryAcquire(
      tool,
      dependencies.rateLimits?.[tool] ?? DEFAULT_RATE_LIMIT,
    );
    if (result.allowed) return undefined;

    return toolError(
      `Rate limit exceeded for ${tool}. Try again in ${Math.ceil(result.retryAfterMs / 1_000)} seconds.`,
    );
  }

  return {
    register(server): void {
      server.registerTool(
        "say",
        {
          description:
            "Queue text for Stack-chan to speak aloud and return immediately with an estimated duration. Set wait=true to wait for playback completion for up to 60 seconds.",
          inputSchema: z
            .object({
              text: z
                .string()
                .trim()
                .min(1)
                .max(1_000)
                .describe("Text for Stack-chan to speak aloud."),
              expression: z
                .enum(EXPRESSIONS)
                .optional()
                .describe("Facial expression to set before speaking."),
              interrupt: z
                .boolean()
                .optional()
                .describe("Stop the current speech before starting this one."),
              wait: z
                .boolean()
                .default(false)
                .describe("Wait for playback completion for up to 60 seconds. Defaults to false (return immediately after enqueueing)."),
            })
            .strict(),
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
          },
        },
        async ({ text, expression, interrupt, wait }) => {
          const offline = requireOnline(dependencies.device);
          if (offline) return offline;
          const limited = rateLimit("say");
          if (limited) return limited;

          try {
            const ticket = dependencies.speaker.say(text, {
              ...(expression === undefined ? {} : { expression }),
              ...(interrupt === undefined ? {} : { interrupt }),
            });
            activeSpeech += 1;
            const onSettled = (): void => {
              activeSpeech -= 1;
            };
            void ticket.done.then(onSettled, onSettled);
            if (!wait) {
              return textResult(`Queued (about ${Math.ceil(ticket.estimatedSeconds)} s).`);
            }
            return textResult(
              (await waitForSpeech(ticket.done))
                ? "Stack-chan spoke the text."
                : "Stack-chan is still speaking.",
            );
          } catch {
            return toolError("Stack-chan could not speak the text.");
          }
        },
      );

      server.registerTool(
        "set_expression",
        {
          description:
            "Set Stack-chan's facial expression without speaking or moving the robot.",
          inputSchema: z
            .object({
              expression: z
                .enum(EXPRESSIONS)
                .describe("Facial expression to show."),
            })
            .strict(),
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
          },
        },
        ({ expression }) => {
          const offline = requireOnline(dependencies.device);
          if (offline) return offline;

          try {
            dependencies.device.send({ type: "face", expression });
            return textResult(`Stack-chan's expression is now ${expression}.`);
          } catch {
            return toolError("Stack-chan's expression could not be changed.");
          }
        },
      );

      server.registerTool(
        "look",
        {
          description:
            "Turn Stack-chan's head to the requested pan and tilt angles in degrees.",
          inputSchema: z
            .object({
              pan: z
                .number()
                .min(-90)
                .max(90)
                .describe("Horizontal angle from -90 to 90 degrees."),
              tilt: z
                .number()
                .min(-30)
                .max(30)
                .describe("Vertical angle from -30 to 30 degrees."),
            })
            .strict(),
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
          },
        },
        ({ pan, tilt }) => {
          const offline = requireOnline(dependencies.device);
          if (offline) return offline;
          if (!dependencies.device.caps.servo) {
            return toolError("This Stack-chan does not support head movement.");
          }

          try {
            dependencies.device.send({ type: "look", pan, tilt });
            return textResult(`Stack-chan is looking at pan ${pan}, tilt ${tilt}.`);
          } catch {
            return toolError("Stack-chan's head could not be moved.");
          }
        },
      );

      server.registerTool(
        "notify",
        {
          description:
            "Send a notification chime, queue a message for Stack-chan to announce, and return immediately without waiting for playback. The result includes topic_id when provided.",
          inputSchema: z
            .object({
              message: z
                .string()
                .trim()
                .min(1)
                .max(1_000)
                .describe("Notification message to announce."),
              priority: z
                .enum(["normal", "high"])
                .optional()
                .describe("High priority interrupts current speech."),
              topic_id: z
                .string()
                .trim()
                .min(1)
                .max(128)
                .optional()
                .describe("Stable topic identifier for future notification grouping."),
            })
            .strict(),
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
          },
        },
        ({ message, priority, topic_id }) => {
          const offline = requireOnline(dependencies.device);
          if (offline) return offline;
          const limited = rateLimit("notify");
          if (limited) return limited;

          try {
            notificationCenter.notify({
              message,
              priority: priority ?? "normal",
              ...(topic_id === undefined ? {} : { topicId: topic_id }),
            });
            return textResult(
              `Notification queued.${topic_id === undefined ? "" : ` topic_id: ${topic_id}`}`,
            );
          } catch {
            return toolError("Stack-chan could not announce the notification.");
          }
        },
      );

      server.registerTool(
        "get_status",
        {
          description:
            "Get whether Stack-chan is online, speaking, or listening and when speech was last heard.",
          inputSchema: z.object({}).strict(),
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
          },
        },
        () => jsonResult(status()),
      );

      server.registerTool(
        "listen",
        {
          description:
            "Wait once for the next utterance heard by Stack-chan and return its transcribed text.",
          inputSchema: z
            .object({
              timeout_s: z
                .number()
                .int()
                .min(1)
                .max(120)
                .optional()
                .describe("Seconds to wait, from 1 to 120. Defaults to 30."),
            })
            .strict(),
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: false,
          },
        },
        async ({ timeout_s }) => {
          if (!dependencies.device.online) {
            return toolError("Stack-chan is offline, so it cannot listen.");
          }
          if (!dependencies.device.caps.mic) {
            return toolError("This Stack-chan does not have a microphone.");
          }

          activeListeners += 1;
          try {
            const utterance = await dependencies.listener.nextUtterance(
              (timeout_s ?? DEFAULT_LISTEN_TIMEOUT_SECONDS) * 1_000,
            );
            if (utterance === null) {
              return jsonResult({ timed_out: true, text: null });
            }
            lastUtteranceAt = now();
            return jsonResult({ timed_out: false, text: utterance.text });
          } catch {
            return toolError("Stack-chan could not listen for the next utterance.");
          } finally {
            activeListeners -= 1;
          }
        },
      );
    },
  };
}

async function waitForSpeech(done: Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      done.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), MAX_SPEECH_WAIT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function requireOnline(device: DeviceLink): CallToolResult | undefined {
  return device.online
    ? undefined
    : toolError("Stack-chan is offline. Check the device connection and try again.");
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value));
}

function toolError(text: string): CallToolResult {
  return { ...textResult(text), isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
