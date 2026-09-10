---
kind: added
summary: Add a Discord bot-DM transport that alerts directly via the Discord REST API
---

`createDiscordDmTransport` sends alerts as a direct message from your
Discord bot, using the Discord REST API directly (`POST
/users/@me/channels` then `POST /channels/{id}/messages`) rather than an
incoming webhook. It exists for callers whose primary alert condition is
"my own API process may be down" — an alert path that must not route
through that same process. Configure it with `DISCORD_BOT_TOKEN` and
`DISCORD_ALERT_DM_USER_ID` (or the equivalent options), and it shares the
existing embed formatting, truncation, and severity colors with the
webhook transport. Rate limits and provider errors are classified into
`AlertDeliveryError` codes so callers can retry or fall back
appropriately, and the bot token is never included in a thrown error,
receipt, or log line.
