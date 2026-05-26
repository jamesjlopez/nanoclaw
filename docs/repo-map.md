# NanoClaw Repo Map

This is a progressive-disclosure map for feature work. Start here when you need
to place a change without rereading the whole codebase.

## Runtime Shape

NanoClaw is a host process plus one container per active agent session.

```
channel adapter -> router -> inbound.db -> agent-runner -> outbound.db -> delivery -> channel adapter
```

The host is Node/TypeScript. The container agent-runner is Bun/TypeScript. The
two sides communicate through per-session SQLite DBs, not stdin, IPC, or file
watchers.

## First Files To Read

| Question | Start Here | Then Read |
|---|---|---|
| How does an inbound user message reach an agent? | `src/router.ts` | `src/session-manager.ts`, `src/db/session-db.ts` |
| How are platform adapters shaped? | `src/channels/adapter.ts` | `src/channels/channel-registry.ts`, `src/channels/chat-sdk-bridge.ts` |
| How does the agent see inbound content? | `container/agent-runner/src/formatter.ts` | `container/agent-runner/src/poll-loop.ts` |
| How do replies leave the system? | `src/delivery.ts` | `container/agent-runner/src/db/messages-out.ts` |
| How are containers spawned and configured? | `src/container-runner.ts` | `src/container-config.ts`, `src/db/container-configs.ts` |
| How are agent groups, messaging groups, and sessions modeled? | `src/types.ts` | `src/db/agent-groups.ts`, `src/db/messaging-groups.ts`, `src/db/sessions.ts` |
| Where do schema changes live? | `src/db/schema.ts` | `src/db/migrations/` |
| Where do container tools live? | `container/agent-runner/src/mcp-tools/` | `container/agent-runner/src/mcp-tools/index.ts` |

## Inbound Message Path

1. A channel adapter calls `ChannelSetup.onInbound(...)` or
   `ChannelSetup.onInboundEvent(...)`.
2. `src/router.ts` resolves the channel/platform pair to a `messaging_groups`
   row, finds wired agents, evaluates engage rules, applies permission gates,
   and calls `deliverToAgent`.
3. `deliverToAgent` resolves or creates a session with `resolveSession`, then
   writes a row to the session's `inbound.db` via `writeSessionMessage`.
4. `writeSessionMessage` stages base64 attachments from message content into
   `data/v2-sessions/.../inbox/<messageId>/` and replaces attachment `data`
   with `localPath`.
5. If the message should wake the agent, `wakeContainer` starts or nudges the
   per-session container.
6. Inside the container, `getPendingMessages` reads due `messages_in` rows and
   `formatMessages` turns them into prompt text for the provider.

Good insertion points:

- **Before routing decisions:** use `setMessageInterceptor` in `src/router.ts`
  only when a module needs to consume a message completely.
- **Before session write:** add normalization/enrichment near `deliverToAgent`
  when every wired agent should receive the enriched content.
- **At formatting time:** extend `container/agent-runner/src/formatter.ts` when
  content is already in the DB but needs a better agent-facing rendering.

## Message Content Conventions

Simple chat messages usually look like:

```json
{
  "sender": "John",
  "senderId": "telegram:123",
  "text": "Check this",
  "attachments": []
}
```

`chat-sdk` messages preserve the Chat SDK serialized shape, with projected
`sender`, `senderId`, and `senderName` fields added by
`src/channels/chat-sdk-bridge.ts`.

Attachments can carry base64 `data` when they enter the host. The host writes
the file to the session inbox and rewrites the attachment to:

```json
{
  "type": "image",
  "name": "attachment.jpg",
  "mimeType": "image/jpeg",
  "localPath": "inbox/msg-id/attachment.jpg"
}
```

The formatter renders a local path as `/workspace/<localPath>` because the
session directory is mounted at `/workspace` inside the container.

## Session DBs

Each session has two SQLite files under `data/v2-sessions/<agent_group_id>/<session_id>/`:

- `inbound.db`: host writes, container reads.
- `outbound.db`: container writes, host reads.

The important invariant is one writer per DB file. Host code opens, writes, and
closes `inbound.db` per operation so container reads observe changes across the
mount boundary.

## Routing Concepts

- `users`: platform identities such as `telegram:123`.
- `messaging_groups`: one chat/channel/DM on one platform.
- `agent_groups`: an agent workspace, memory, config, and container identity.
- `messaging_group_agents`: wirings from chats to agents, including engage
  mode and session mode.
- `sessions`: concrete conversation state for an agent plus messaging group and
  optional thread.

Engage modes live in `src/router.ts`:

- `pattern`: regex over message text.
- `mention`: platform adapter says the bot was mentioned.
- `mention-sticky`: first mention starts a per-thread session; later thread
  messages continue engaging.

## Modules And Hooks

Modules register hooks rather than patching the central router flow directly.
The main hook setters are in `src/router.ts`:

- `setSenderResolver`
- `setAccessGate`
- `setSenderScopeGate`
- `setMessageInterceptor`
- `setChannelRequestGate`

Existing module examples live in `src/modules/permissions/`,
`src/modules/approvals/`, `src/modules/scheduling/`, and
`src/modules/self-mod/`.

## Channel Adapters

The adapter contract is `src/channels/adapter.ts`. Specific adapters are usually
skill-installed, while trunk keeps the registry and bridge:

- `src/channels/channel-registry.ts`: adapter registration and lookup.
- `src/channels/chat-sdk-bridge.ts`: wraps Chat SDK platforms and normalizes
  inbound attachments, sender fields, mentions, DMs, and threaded messages.
- `src/channels/index.ts`: channel registration imports.

## Container Agent Runner

The container process lives under `container/agent-runner/src/`.

- `index.ts`: startup and MCP server wiring.
- `poll-loop.ts`: pending-message polling, provider invocation, completion ack.
- `formatter.ts`: DB message rows to provider prompt text.
- `providers/`: provider abstraction and implementations.
- `mcp-tools/`: tools exposed to the agent, including scheduling,
  interactivity, self-modification, and agent-to-agent messaging.

## Adding Link Or Media Ingestion

For URL-to-content enrichment, prefer a host-side module that runs before
`writeSessionMessage` or as a background job that writes a follow-up
`messages_in` row. Keep raw media acquisition, transcription/OCR, extraction,
and formatting separate so the expensive parts can be cached and retried.

For the Instagram/Reels URL-to-transcript plan, see
[`docs/instagram-ingestion.md`](instagram-ingestion.md).

Recommended shape:

1. Detect candidate URLs in `content.text` and `chat-sdk` links.
2. Canonicalize the URL and check a cache under `data/`.
3. Resolve metadata/media through a provider interface.
4. Transcribe audio or OCR sampled frames/images.
5. Store compact text artifacts in message content.
6. Render those artifacts in `formatter.ts`.

This avoids asking the agent to scrape links during its normal reasoning turn
and keeps provider-specific failures out of the core routing path.

## Tests To Look For

- Router and routing behavior: `src/host-core.test.ts`,
  `src/db/session-db.test.ts`, `src/container-restart.test.ts`.
- Channel bridge behavior: `src/channels/chat-sdk-bridge.test.ts`.
- Formatting behavior: `container/agent-runner/src/formatter.test.ts`.
- Poll loop and provider behavior: `container/agent-runner/src/poll-loop.test.ts`,
  `container/agent-runner/src/providers/*.test.ts`.

Use focused tests around the insertion point first, then add an integration test
only if the change crosses host/container or DB boundaries.
