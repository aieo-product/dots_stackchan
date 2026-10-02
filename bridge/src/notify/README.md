# Notification integration

Create one `createNotificationCenter({ device, speaker })` for each device and
share it with MCP (`notificationCenter`) and the Slack adapter. Both submit
`{ source: "mcp" | "slack", message, priority, topicId?, receivedAt }`.
`receivedAt` is Unix milliseconds; the injected `now()` determines arrival-time
deduplication and scheduling, so delayed source timestamps cannot bypass dedup.
The return value is `"queued"` or `"duplicate"`; acceptance does not await playback.

The center hashes NFKC-normalized, whitespace-collapsed content with SHA-256.
Accepted arrivals start a dedup window; duplicates do not extend it. Priority is
high before normal, with arrival order preserved within a priority. High waits
for device speech and active notification playback to finish, without cancelling
speech. Normal waits for two continuous seconds outside listening, thinking and
speaking. Device state is read from `message` events; no hub polling is required.
Each delivery sends the notification chime immediately before `speaker.say`.

| Environment setting | Default | Meaning |
| --- | --- | --- |
| `QUIET_HOURS` | `22:00-07:00` | Local OS time, start inclusive/end exclusive; empty disables quiet hours. Overnight and same-day windows are supported. Equal endpoints are invalid. |
| `QUIET_ALLOW_HIGH` | `false` | Allow high priority announcements during quiet hours. |
| `NOTIFY_DEDUP_WINDOW_S` | `600` | Arrival-time dedup window in seconds; zero disables deduplication. |
| `LOG_NOTIFICATIONS` | `false` | Include notification bodies in logs only when explicitly true. |

Quiet notifications remain in memory. At the local quiet end they become
eligible automatically. D→B `{ "type": "event", "kind": "touch" }` releases the
current backlog; later arrivals still obey quiet hours. Conversation timing and
priority continue to apply. `notice.pending` reflects queued messages, excluding
the one currently playing. Offline messages wait for a device event after
reconnection; `hello` refreshes the count. Queue/count/log failures never log
exception text. Failed playback is logged as metadata and the next item proceeds;
failed notifications are not retried automatically. Queues are not persisted
across process restarts.

After successful playback, use `center.context.forUtterance(startedAt)` to obtain
`{ reply_to: topicId }` for #10's `stackchan.utterance`. Supply the utterance start
time in milliseconds so transcription latency does not consume the ten-second
window. Without a topic, or outside the window, it returns `undefined`. The
context can be spread into the outgoing utterance payload. Stop the center with
`dispose()` at device/application teardown to clear queued work and timers.

## Protocol v1 notification count

The shared gateway schema and `docs/protocol.md` accept this message:

| Direction | `type` | Payload fields |
| --- | --- | --- |
| B→D | `notice.pending` | `{count: non-negative integer}`; absolute number of queued notifications for this device, excluding active playback |

Example: `{ "type": "notice.pending", "count": 2 }`. A later count replaces the
previous display value; zero clears it. The bridge emits count changes and
refreshes the count on device `hello`. Firmware display and notification
expression support remain integration work for #5/#17. The gateway now validates this message; the firmware count display remains
a separate hardware/UI task. Notifications use `purpose: "notification"` so
bridge mode honors `NOTIFY_TTS_ENGINE`.
