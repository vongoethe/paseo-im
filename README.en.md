# paseo-im

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Channels](https://img.shields.io/badge/IM%20channels-12-blue)
![Platform](https://img.shields.io/badge/platform-Paseo-green)

Connect 12 IM channels to Paseo agents: Feishu (Lark), WeChat, DingTalk, WeCom (bot), WeCom (self-built app), QQ, Slack, Telegram, Discord, WhatsApp, iMessage, Matrix. Inbound IM message → bridged to the bound Paseo agent → reply delivered back in the channel's native shape (message edit / streaming card / typing / chunked text).

[中文文档](./README.md)

Reference implementations: [dsh-im](https://github.com/xmanrui/dsh-im) (channel protocol facts, MIT) and [paseo-telegram](https://github.com/Daaaaave/paseo-telegram) (plugin layout template, MIT).

## Live channel status

| Channel | Status | Notes |
| --- | --- | --- |
| QQ | ✅ verified live | Official WebSocket gateway, RESUME reconnect |
| Telegram | ✅ verified live | Stable long-polling, shared-history session |
| WeChat | ✅ verified live | iLink QR pairing loop closed, private chat only |
| Other 9 channels | adapters + tests complete | Live verification pending credentials |

Channel status / defect fix index / no-human acceptance commands: [docs/status.md](./docs/status.md).

## Install

This fork targets Paseo **0.17.4 through 0.17.x** (daemon and app), with both SDKs pinned to 0.17.4. `stable` is the intended default branch; `main` tracks upstream. See [fork maintenance](./docs/fork-maintenance.md) for the update process and publication status.

```sh
paseo plugin add /absolute/path/to/paseo-im
```

Or install from npm / GitHub (published as TypeScript source; `npm ci --omit=dev --ignore-scripts` runs at install). An **IM** entry appears in the sidebar after install.

## Channels

| Channel | Credentials | Progress display | Notes |
| --- | --- | --- | --- |
| Telegram | Bot Token from @BotFather | edit-in-place + typing | DM direct reply; group @/reply trigger; native topic threads |
| Slack | Bot Token (xoxb) + App Token (xapp), Socket Mode required | native streaming | needs `connections:write` scopes |
| Discord | Developer Portal Bot Token | edit-in-place + typing | enable Message Content Intent; first @ in a guild auto-creates a thread |
| Feishu (Lark) | App ID + App Secret (feishu/lark domain) | cardkit streaming card (falls back to plain send) | needs `im:message` read + `im:resource` upload |
| DingTalk | Client ID + Client Secret | AI Card streaming | bot capability must be enabled; expired sessionWebhook falls back to bot API |
| QQ | AppID + AppSecret | typing | markdown rejection falls back to plain text; passive reply window limits |
| WeCom (bot) | Bot ID + Secret, or QR pairing | official streaming replyStream | — |
| WeCom (self-built app) | corpId / agentId / secret / token / AESKey | encrypted reply + proactive send | **needs a publicly reachable callback base URL** |
| WhatsApp | QR pairing (Baileys multi-device) | edit + composing + read receipt | unofficial protocol, ban risk; self-chat default can be relaxed in policy |
| WeChat | QR login + pairing code (iLink bot API) | typing (sendtyping) | private chat only; unofficial protocol, stability risk |
| iMessage | none (macOS permissions) | direct final reply | macOS daemon only: Full Disk Access + Messages automation; unsupported on Linux |
| Matrix | homeserver + accessToken, or password | m.replace edit + typing | E2EE not yet supported |

## Routing (message destination)

Each connection picks a default destination, overridable per conversation:

- **Existing Paseo chat**: messages enter the same agent and history (multi-session sharing optional).
- **Workspace**: each IM conversation spawns its own agent in the workspace (provider/model/mode/thinking/system prompt configurable).

Saving a new destination automatically migrates per-conversation bindings that followed the previous agent — see gotchas §5.8.

## Access & security

- Direct messages: everyone, or an allowlist (channel-specific sender id shape).
- Group trigger: @/reply or all messages; admission: allowlist / group admin / everyone.
- Group joining: auto, or approve-first (approve/remove from the settings page).
- Secrets (token/secret) stored at `$PASEO_HOME/plugin-data/paseo-im/secrets/<id>.json` (0600); connection config contains no secrets; writes use optimistic locking.
- Dispatch replay protection: deterministic id per inbound message, verified against the agent timeline after recovery — never sent twice.
- Timeout re-delivery: on wait timeout the task keeps running and the result is re-delivered to the original conversation (explicit failures retry at most three times; ambiguous outcomes are never retried).
- Agent clarification questions are forwarded to the IM chat; reply with an option number to answer on the user's behalf.

## Global settings

Image input limits (original size cap / per-image model cap / total cap / count), attachment retention, busy behavior (queue or steer), deferred re-delivery wait window.

## Docs

| Doc | Content |
| --- | --- |
| [docs/status.md](./docs/status.md) | Current status handbook: channel states, defect fix index (commit map), no-human acceptance commands, backlog |
| [docs/gotchas.md](./docs/gotchas.md) | Pitfalls/experience/debugging knowledge base (runtime constraints, protocol traps, host differences, forensics, reload recovery) |
| [docs/channel-test-matrix.md](./docs/channel-test-matrix.md) | 12 channels × 11 categories credential-free test matrix |
| [docs/design.md](./docs/design.md) | Architecture design |
| [docs/webui-acceptance.md](./docs/webui-acceptance.md) | WebUI and live acceptance records |

## Contributing

Human and agent contributors are equally welcome:

- [CONTRIBUTING.md](./CONTRIBUTING.md): setup, gates, commit conventions, PR checklist, maintainer conventions
- [AGENTS.md](./AGENTS.md): agent collaborator operating rules (gate iron rules / boundaries / knowledge loop / collaboration boundaries / disclosure)
- [SECURITY.md](./SECURITY.md): private vulnerability reporting
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md): code of conduct
- PRs with agent involvement must disclose participation level and model per the PR template (Harness Model format)

## Development

```sh
npm install
npm run typecheck   # dual tsconfig (server + client)
npm test            # node --test (runs TS natively, Node 22.18+)
npm run check:package
npm run check:runtime
paseo plugin install /absolute/path/to/paseo-im   # or reload during local development
```

Layout: `server/channels/<channel>/` per-channel adapter (transport + normalize + send + pairing); `server/` bridging engine (policy/routing/queue/progress/questions/deferred/bridge/manager); `shared/` contracts (model/config/RPC, shared by client+server); `client/` settings UI (RN primitives); `tests/` node:test unit tests (all fake transports, no real network).

## License

MIT — see [LICENSE](./LICENSE). Third-party attribution and dependency license audit: [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). Channel protocol facts ported from xmanrui/dsh-im (MIT), with provenance noted in file headers. The WeChat and iMessage channels use unpublished or unofficial protocols; stability and account risk apply, and use implies acknowledgement and acceptance.
