# aux4/bot-chat

Connect Cloud Chat participants to generic aux4 agents through aux4/bot.
The adapter implements verification, normalization, typing, formatting and delivery.
It handles text and an optional sender display name; attachments are not yet supported.

## Installation

```sh
aux4 aux4 pkger install aux4/bot-chat
```

The cloud host package installs this dependency automatically.

## Connection

Cloud Chat exposes the configured bot in People, alongside other participants.
Open a DM or add it to a channel. The server signs the message with a dedicated
connection key, then posts it to an asynchronous platform webhook bound to
`cloud-bot chat`. The webhook and this adapter both validate the signature and five-minute replay window.
`X-Aux4-Chat-Timestamp` carries Unix seconds; `X-Aux4-Chat-Signature` is
`sha256=` followed by the hex HMAC-SHA256 of `<timestamp>.<exact raw body>`.
The queue and bot state remain in the bot machine's `db: cloud` repository.

Configure the Chat server with `CHAT_BOT_AGENT`, `CHAT_BOT_NAME`,
`CHAT_BOT_INGRESS_URL` and a secret binding for `CHAT_BOT_SIGNING_SECRET`.
Configure the bot host with the same signing-secret binding,
`CHAT_BOT_CALLBACK_URL` pointing to Chat's `/api/apps/chat/bot-event`,
and the configured agent machine. One configured bot is supported per Chat deployment.
Never supply connection credentials from browser input.

The agent receives ordinary text, sender context, conversation and message IDs.
It returns a structured canonical turn; it has no knowledge of Chat transport.
Agent history remains on the agent VM. Chat stores received messages in its
existing membership-protected room store. Different rooms have different agent
conversation IDs; the same room continues its history.

Completion requires the exact pending turn's callback capability. Only a digest
is stored by Chat. Retrying a delivery cannot create a second message, and a
member removed before completion cannot cause a new bot reply to be appended.
Signing keys and callback capabilities are never returned to the browser.

## Provider commands

The bot core calls `aux4 bot chat verify`, `ingest-parse`, `typing`, `format`,
`send` and `download` with JSON on stdin. The host package owns the generic
agent bridge, passes text as literal data, and pins the target machine;
message text never selects a machine or becomes shell syntax.

## Local verification

```sh
node --test package/test/chat.test.mjs
cd package
aux4 test run
```

Tests use synthetic keys and local/injected transports, with no hosted inference.

Chat sender context carries the authenticated display name and a stable opaque user ID. It grants no roles or permissions and contains no phone number or credential.
