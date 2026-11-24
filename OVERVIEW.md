# paseo-im

Connect IM bots to Paseo agents. One plugin, twelve channels: Feishu, WeChat, DingTalk, WeCom bot, WeCom self-built app, QQ, Slack, Telegram, Discord, WhatsApp, iMessage, and Matrix. Messages arriving on any channel are dispatched to the linked Paseo agent, and the agent's answer is delivered back in the channel's native form.

## How it works

Each connection runs a channel adapter in the plugin's daemon subprocess: it holds the transport (long polling, WebSocket, stream mode, HTTP callback, or local chat.db), normalizes inbound messages, and sends replies through the platform API. A channel-agnostic bridge handles access policy, routing (one existing Paseo chat, or a workspace where every conversation gets its own agent), per-conversation serialization, progress display, clarification questions, and timeout recovery. Credentials live in 0600 files under the plugin data directory; connection settings carry an optimistic revision so several clients can edit safely.

## Setup

This fork requires Paseo 0.17.3 through 0.17.x on both the daemon and app. Open **IM** in the sidebar, pick a channel, and enter that platform's bot credentials (token, app ID/secret, or homeserver login). WhatsApp, WeChat, and WeCom bot use a QR pairing flow inside the screen instead of manual tokens. Each connection needs a destination: an existing Paseo chat, or a workspace with a provider/model — conversations then create their own agents in that workspace. iMessage requires a macOS daemon host with Full Disk Access and Messages automation; on Linux it shows as unsupported. The WeCom self-built app requires a publicly reachable callback base URL.

## Capabilities and limits

Progress is shown natively per channel where possible: message editing (Telegram, Discord, WhatsApp, Matrix), streaming messages or cards (Slack, WeCom, DingTalk, Feishu), typing indicators elsewhere. Clarification questions asked by agents are relayed to the chat and answered by replying with an option number. Group admission, per-chat routing overrides, image input limits, and a result-redelivery window after wait timeouts are configurable. WeChat runs on an undocumented iLink bot API and WhatsApp on the unofficial Baileys protocol — both can break without notice. Matrix ships without encryption. Voice messages are stored as files, not transcribed.
