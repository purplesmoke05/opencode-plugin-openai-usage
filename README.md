# opencode-plugin-openai-usage

opencode TUI sidebar plugin that shows OpenAI (ChatGPT / Codex OAuth) plan
usage and credits, next to the other usage sections.

## What it shows

- `OpenAI (Codex)` — plan usage section in the right sidebar
- `Weekly (7d) ██████████░░░ 83% Left · Resets In 6d21h` — the primary rate-limit
  window (`used_percent` converted to percent left, reset countdown from
  `reset_after_seconds`)
- `Credits 0 · pro` — credit balance and plan type (`unlimited` / `has_credits`
  states are handled)
- A warning line while `limit_reached` is true

The section updates itself every 60 seconds; while the first fetch is pending
(or failed) it retries faster (5s / 10s).

## Data source

`GET https://chatgpt.com/backend-api/wham/usage` — the same usage endpoint the
Codex CLI reads. It returns the plan type, the primary/secondary rate-limit
windows, credits, and additional per-model limits.

The request is read-only and does not run a model call.

## Authentication

The OAuth access token is read from the opencode auth store:

```
~/.local/share/opencode/auth.json  →  "openai" entry  →  { access, accountId }
```

The token is used only for the usage request above. This plugin never refreshes
or writes tokens: refresh tokens rotate, so refreshing from a third party can
invalidate the copy held by opencode / the Codex CLI. If the access token is
expired the section shows `openai: unauthorized (token expired?)` until one of
those tools refreshes it.

## Install

```bash
npm install && npm run build
```

Register the TUI plugin in `~/.config/opencode/tui.json`:

```json
{
  "plugin": [
    "file:///absolute/path/to/opencode-plugin-openai-usage/src/tui.ts"
  ]
}
```

Restart opencode (TUI config is read once at startup).
