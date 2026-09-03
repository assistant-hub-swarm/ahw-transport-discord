# ahw-transport-discord

The **Discord transport** for [assistant-hub-swarm][core]: stateless gateway
clients that register with a running core, forward every update as transport
events, perform the sends the core asks for, and host Discord's own actions as
MCP tools.

It has no database and no files. Everything it knows at runtime it learns from
the core at boot (registration answers with the desired state) and from the bus
(config changes). Its whole job is translation.

It is also the **second proof** of the transport contract: it was written
against the published [`@assistant-hub-swarm/transport-sdk`][sdk] and
[the manual][manual] alone, and the core needed no change to accept it — no
branch, no capability flag, no list to add `discord` to.

## Run it

Against a core you are already running (its Redis and its internal token):

```bash
npm install              # needs a GitHub Packages token — see below
cp .env.example .env     # REDIS_URL, INTERNAL_API_TOKEN, CORE_API_URL, SELF_URL
npm run dev
```

`.npmrc` points the `@assistant-hub-swarm` scope at GitHub Packages, which
wants a token on every request: a public package there is readable by any
account, but not anonymously. Put one with `read:packages` in your user-level
`~/.npmrc`, so it never reaches this repository:

```
//npm.pkg.github.com/:_authToken=<token>
```

Or as the container, which is how an operator runs it — one service next to
the core's, and no change to the core:

```yaml
  discord:
    image: ghcr.io/assistant-hub-swarm/ahw-transport-discord:1.0.0
    depends_on:
      redis: { condition: service_healthy }
    environment:
      NODE_ENV: production
      PORT: 3220
      SELF_URL: http://discord:3220     # what the core will call
      REDIS_URL: redis://redis:6379
      CORE_API_URL: http://app:3200
      INTERNAL_API_TOKEN: ${INTERNAL_API_TOKEN:-change-me}
      TZ: ${TZ:-UTC}
    restart: unless-stopped
```

Do not publish its port (the internal API is the core's alone) and do not add
it to the core's `depends_on` — the core depends on no transport, and this one
registers itself whenever it comes up.

## Setting up the bot

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. **New Application** → **Bot** → **Reset Token**, and paste that token into
   the assistant's Discord connection in the dashboard.
2. Under **Privileged Gateway Intents**, enable **MESSAGE CONTENT INTENT**.
   Without it the bot connects, looks healthy, and receives every message with
   an empty body — the single most common way this transport appears broken
   when it is merely unconfigured.
3. **OAuth2 → URL Generator**: scope `bot`, permissions *View Channels*, *Send
   Messages*, *Read Message History*, *Add Reactions*, *Attach Files*. Open the
   generated URL to invite it to a server. DMs need no invitation.

## Environment

Bootstrap only. Bot tokens, which assistants to run, personas, tasks — all of
that comes from the core at registration and on every change.

| Variable | Required | Purpose |
| --- | --- | --- |
| `REDIS_URL` | yes | The bus and the update queue |
| `INTERNAL_API_TOKEN` | yes | Must equal the core's |
| `PORT` | no | This service's HTTP port (default 3220) |
| `CORE_API_URL` | no | The core's base URL (default `http://localhost:3200`) |
| `SELF_URL` | no | The base URL it **announces** — what the core calls back. Default `http://localhost:<PORT>` |

## What lives where

The folders follow the **direction of travel**, which is how the contract
itself reads. `discord/` is the only part that knows the Discord API exists.

```
src/
  index.ts              boot order, shutdown

  core/                 everything that speaks to the core
    desired-state.ts    registration, the desired state, the retry
    updates.ts          the update queue: publisher, envelope, seen-cache
    client.ts           the synchronous calls back (menu press, mirror lookup)

  inbound/              Discord -> core
    normalize.ts        one gateway message becomes one transport event
    addressing.ts       the structural verdict, per receiving bot

  outbound/             core -> Discord
    delivery.ts         the bus consumer: reply delivery, typing, deliver trace
    send.ts             the one send: split, send each part, report each
    split.ts            cutting under Discord's 2000-character cap

  discord/              the only code that knows the Discord API
    manager.ts          gateway clients, reconcile, intents, event handlers
    connections.ts      the running-connection roster
    sender.ts           the platform sends (text, files, menus, reactions)
    ids.ts              snowflakes, citation links, mention stripping
    media/ingest.ts     attachments and stickers, fetched and normalized

  http/                 this service's own surface
    api.ts              /health and /internal/*
    mcp.ts              /mcp: the tools and the turn binding
```

Tests sit beside what they cover.

## Where Discord differs from Telegram

Both implement the same contract; almost everything that differs is confined
to `discord/`. The parts worth knowing:

| | |
| --- | --- |
| **Ids are snowflakes** | 64-bit, and `Number()` corrupts them. The wire keeps every id a string for exactly this reason, so nothing here parses one |
| **2000 characters, not 4096** | Long replies split far more often, which is why the boundaries in `split.ts` matter rather than a blunt slice |
| **Mentions are structured** | `<@id>`, not a name to match — so the structural check is exact, with no case folding to get wrong. A role or `@everyone` ping is deliberately *not* addressing |
| **No voice bubble** | The core's voice reply arrives as audio plus its spoken text; this transport sends the audio as an attachment and reports `asVoice: false` rather than claiming a form the platform lacks |
| **Menus are buttons** | The feedback flow's 👍/👎 menu is an action row, and a press is an interaction that must be answered within three seconds — so the toast comes back as an ephemeral reply |
| **No chat titles to set** | A channel always has its own name, so `PUT /internal/chats/:id/title` is simply not served. An action a platform lacks is a route that does not exist, not a route that answers "unsupported" |
| **No ffmpeg** | Attachments arrive with a CDN URL and a content type, so there is no frame sampling and no file-id round trip |

## Development

```bash
npm run typecheck
npm run test        # the pure decisions: the addressing verdicts, the split,
                    # and that snowflakes survive as strings
```

Registration, the reconcile and the bus subscriptions all run at boot, so
restart the service after a change before judging a live check — `tsx watch`
will not re-run them.

Releases: bump `version` in `package.json`, push to `main`, and the workflow
verifies, pushes `ghcr.io/assistant-hub-swarm/ahw-transport-discord` on that
version and tags the commit.

## The contract

Everything that crosses the boundary comes from the [SDK][sdk]. Two versions
matter, and they are different numbers: this repository's own version is what
its image is tagged with, and `CONTRACT_MAJOR` — exported by the SDK — is the
**wire** major, announced at registration. A core that speaks another major
refuses this transport by name, with a reason its dashboard shows.

[core]: https://github.com/assistant-hub-swarm/ahw-core
[manual]: https://github.com/assistant-hub-swarm/ahw-core/blob/main/docs/development/adding-a-transport.md
[sdk]: https://github.com/assistant-hub-swarm/ahw-core/blob/main/packages/transport-sdk/README.md
