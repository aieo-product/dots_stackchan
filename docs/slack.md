# Slack DM mirror (optional)

Slack is an optional route for installations that cannot expose a public MCP URL.
It mirrors one **existing, one-to-one DM** between you and Dot. Speech is posted
with your user token, as you; each new Dot post (including thread replies,
unsolicited notices, and late replies) goes through `NotificationSink.submit`.
Your own posts from the bridge, desktop, or phone are never spoken. No channel,
DM, mention, or thread is created by the bridge. Dot's instructions need no changes.

The transport uses the official `@slack/socket-mode` and `@slack/web-api` SDKs.
Its `undici` peer dependency stays on major 7 to support the repository's Node 22 baseline.
[Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/) receives
events through an outbound WebSocket; neither a public request URL nor Tailscale
is needed. The SDK manages heartbeat and automatic reconnection. Only one bridge
instance should mirror a given DM.

## App manifest and permissions

Create a Slack app **from a manifest** in a test workspace using this YAML:

```yaml
_metadata:
  major_version: 1
display_information:
  name: Stack-chan DM Mirror
oauth_config:
  scopes:
    user:
      - im:history
      - im:read
      - chat:write
      - users:read
settings:
  socket_mode_enabled: true
  token_rotation_enabled: false
  org_deploy_enabled: false
  event_subscriptions:
    user_events:
      - message.im
```

There are no bot scopes or bot event subscriptions. The app-level token is created
separately in Basic Information → App-Level Tokens with **`connections:write` only**.

| Token | Permission | Use |
| --- | --- | --- |
| App-level | `connections:write` | Open the Socket Mode connection |
| User | `im:history` | Subscribe to new DM posts through `message.im` |
| User | `im:read` | Find and validate the existing Dot DM, with pagination |
| User | `chat:write` | Post transcribed speech as the authorizing user |
| User | `users:read` | Match DM peers when Dot is configured by bot ID |

The [manifest reference](https://docs.slack.dev/reference/app-manifest/) supports
`user_events`. [`message.im`](https://docs.slack.dev/reference/events/message.im/)
requires `im:history`; [`conversations.list`](https://docs.slack.dev/reference/methods/conversations.list/)
supports DM discovery with `im:read`. [`chat:write`](https://docs.slack.dev/reference/scopes/chat.write/)
supports user tokens. The legacy `as_user` parameter is deliberately omitted:
it is restricted to classic apps in the current
[`chat.postMessage` reference](https://docs.slack.dev/reference/methods/chat.postMessage/).

Slack scopes authorize access to the user's DMs, **not just the selected DM**.
The bridge filters one DM locally and does not persist history or transcripts.
Treat the user token as a credential with your own permissions. Workspace policy
may require admin approval; install this app only for the intended user.

## Setup

1. Create the app with the manifest, then install it in the workspace as yourself.
   OAuth & Permissions shows the **User OAuth Token** (prefix `xoxp`); do not use
   a Bot User OAuth Token. Reinstall the app after changing scopes.
2. Generate the app-level token (prefix `xapp`) with `connections:write`.
3. Open your existing Dot DM in Slack. Copy Dot's member ID from its profile.
   Prefer its user ID; a bot ID can also be used. A bot ID is resolved by checking
   the profiles of existing DM peers with `users.info`.
4. Optionally copy the DM conversation ID from its Slack link (the ID starting
   with `D`). `SLACK_CHANNEL` must identify an existing DM with Dot; public,
   private, and group channels are outside this manifest's scope. If the bridge
   cannot find a DM, open it manually in Slack and try again. It never calls
   `conversations.open` and does not need `im:write`.
5. Store both tokens in macOS Keychain using hidden prompts:

   ```sh
   akc set SLACK_APP_TOKEN
   akc set SLACK_USER_TOKEN
   export SLACK_APP_TOKEN=keychain://SLACK_APP_TOKEN
   export SLACK_USER_TOKEN=keychain://SLACK_USER_TOKEN
   export SLACK_ENABLED=true
   export SLACK_DOT_USER_ID='<dot-user-id>'
   export ROUTE=slack
   akc run -- npm run start --workspace bridge
   ```

The start command above requires the application wiring described below. This
issue supplies injectable modules; the existing gateway entry point does not
enable them yet. Do not put token values in `.env`, files, shell history, or logs.
`akc run` resolves the references only in the child process; configuration expects
the resulting tokens, not unresolved `keychain://` references.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `SLACK_ENABLED` | `false` | Opt in with `true`; disabled mode needs no tokens |
| `SLACK_APP_TOKEN` | required when enabled | Socket Mode app-level token |
| `SLACK_USER_TOKEN` | required when enabled | Authorizing user's OAuth token |
| `SLACK_DOT_USER_ID` | required when enabled | Dot user ID or bot ID |
| `SLACK_CHANNEL` | unset | Validate this DM, or find Dot's existing DM automatically |
| `SLACK_READ_SENTENCES` | `2` | Read the first 1–20 sentences |
| `ROUTE` | `mcp` | Forward utterances through `mcp`, `slack`, or `both` |

With `ROUTE=both`, Dot might receive the utterance through both routes. Incoming
Slack notices remain enabled even with `ROUTE=mcp`, if the mirror is started.

## Application integration

The owning application injects the #6 utterance source, the #16 notification
center, and the #10 MCP utterance handler. The integration is intentionally outside
`index.ts`, the gateway config, and `device-hub.ts` in this issue. For example,
in the owning composition module:

```ts
import { loadSlackConfig } from "./slack/config.js";
import { SocketSlackClient } from "./slack/client.js";
import { SlackMirror } from "./slack/mirror.js";
import { loadUtteranceRoute, UtteranceRouter } from "./slack/router.js";

const slack = loadSlackConfig();
const route = loadUtteranceRoute();
if (route !== "mcp" && !slack.enabled) {
  throw new Error("Enable Slack for the selected ROUTE");
}
const router = new UtteranceRouter(utterances, route, handleMcpUtterance, logger);
const mirror = slack.enabled ? new SlackMirror({
  client: new SocketSlackClient(slack, logger),
  utterances: router,
  notifications: notificationCenter,
  readSentences: slack.readSentences,
  logger,
  onStatus: (status) => updateSlackStatus(status),
}) : undefined;
await mirror?.start();

// During application shutdown:
router.dispose();
await mirror?.dispose();
```

Here `utterances`, `handleMcpUtterance`, `notificationCenter`, `logger`, and
`updateSlackStatus` are the application's injected dependencies. Construct the
router once so utterances do not also go to an older, separately subscribed route.
`onStatus` reports `connecting`, `online`, `reconnecting`, or `offline`; the owning
UI can render 「オフライン」 for the last state. Device gateway disconnect/offline
rendering belongs to the firmware/integration branches. Stopping this bridge only
disconnects its own socket; your Slack DM and Dot remain available.

`bridge/src/slack/contracts.ts` exports these shared interfaces:

```ts
interface SpeechTicket {
  readonly id: string;
  readonly estimatedSeconds: number;
  readonly done: Promise<void>;
}
interface Speaker {
  say(text: string, opts?: { expression?: Expression; interrupt?: boolean }): SpeechTicket;
  cancelAll(): void;
}
interface NotificationSink {
  submit(n: {
    source: "slack"; message: string; priority: "normal" | "high"; topicId?: string;
  }): void;
}
interface UtteranceSource {
  on(event: "utterance", cb: (u: { text: string; lang: string; reply_to?: string }) => void): void;
}
```

`Expression` comes from the existing face protocol. The notification center owns
the Speaker: `say()` synchronously returns a ticket, `estimatedSeconds` is roughly
Japanese character count × 0.15, and `done` resolves after successful device
`tts.done` or rejects on failure/cancellation. The mirror never bypasses the
notification center by calling Speaker directly. `topicId` uses the conversation
and thread/root timestamp; notifications use normal priority.

## Speech, reconnects, and failures

Text conversion happens locally. Code blocks/inline code, URLs, tables, mentions,
and emoji codes become short spoken descriptions. Long text reads the first N
sentences followed by 「続きは Slack を見てね」. A 600-character cap also bounds a
single sentence without punctuation. Empty messages are ignored; table-only
Block Kit posts become 「表があるよ」. Edits/deletions and system events are ignored.

There is no reply timeout, timeout apology, or waiting expression. Dot's messages
are read when they arrive. The device should return to idle through the normal
speech/notification lifecycle.

Each Socket Mode envelope is acknowledged before processing. Duplicate message
timestamps are filtered across reconnects and stop/start in the same mirror,
with a bounded 1,000-message cache. The notification center provides cross-route
deduplication. Cache/history is not persisted; there is no history catch-up for
messages sent while this bridge is offline. A new identical post with a different
timestamp is still submitted.

Utterances are not buffered during an outage. Writes have no automatic API retry
because a network timeout might follow a successful post. Generic failure logs
contain no SDK arguments, raw API errors, message text, IDs, or tokens. Verify an
uncertain post in Slack before manually repeating it. A failed startup cleans up
its socket and can be retried; automatic socket reconnection handles disruptions
after startup. Terminal authorization failures require fixing the credentials.

## Verification

Unit tests use fake SDKs/clients and cover token separation, existing DM discovery,
sender filtering, unsolicited and threaded replies, long text, retries, routing,
shutdown, reconnects, and sanitized errors. The PII scanner also detects app-level
tokens; its tests assemble dummy values rather than storing a token-shaped literal.

After wiring the other branches, use a **test-only workspace** for `/issue-test`:

1. Enable the mirror and speak. Confirm the existing DM shows your own identity,
   without a new channel/thread or a Dot instruction change.
2. Confirm Dot's reply and an unsolicited Dot notice are both spoken.
3. Write from desktop/phone; confirm your own post stays silent.
4. Try code, links, tables, a long post, and a delayed reply; verify their speech.
5. Interrupt the bridge network, reconnect, and check the status and retry behavior.
6. Stop the bridge; confirm Slack/Dot still work and the device shows offline after
   its gateway connection closes.

Save a redacted screenshot of the DM and a short device video. Hide workspace,
member identity, avatars, conversation IDs, and tokens before sharing evidence.
Live Slack delivery, OAuth installation, Dot behavior, and device/UI speech require
this test; unit tests alone do not establish those results.
