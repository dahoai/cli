# @dahoai/cli

A command line (`daho`) and a local MCP server (`daho mcp`) for the DAHO API gateway. Use the apps you
connected in the DAHO portal (Gmail, Google Ads, HubSpot, Stripe, Resend and more) with one API key.

> Status: tested against a fake gateway and, on 2026-09-29, against the live gateway (CLI and MCP: discovery,
> a real read, blocked `${` and `..` paths, no key in any output). **Not published to npm yet.**

## Requirements

- Node 20+
- A DAHO API key: create one in the DAHO portal (API keys page) and put it in the environment as
  `DAHO_API_KEY`. The key is read only from the environment and is never printed or stored.
- Optional: `DAHO_GATEWAY_URL` (default `https://gateway.daho.ai`; must be https, or http for localhost only).

## Run

Once published: `npx -y @dahoai/cli <command>`. From a local clone: `npm ci && npm run build`, then
`node dist/bin.js <command>`.

## CLI

```text
daho apps [--json]                      list apps and whether they are connected
daho connections [--json]               list your connections
daho api <path> [options]               call an app: <path> is /{app}/{native path}?{query}
daho mcp                                run the MCP server on stdio
daho --version | --help

Options for "daho api":
  -X, --method METHOD    GET (default), HEAD, POST, PUT, PATCH or DELETE; POST when -d is given
  -d, --data BODY        request body: a string, @file, or @- for stdin (JSON is assumed)
  -H, --header 'N: v'    extra header (repeatable); Authorization, Host and Cookie cannot be set
      --connection ID    choose one connection when you have several for the app
  -i, --include          print the response headers to stderr
```

The response body goes to stdout and the HTTP status to stderr. Exit codes: `0` success, `1` HTTP error
(the body is still printed), `2` usage or configuration error, `3` network failure.

```sh
daho apps
daho api /google/gmail/v1/users/me/profile
daho api /stripe-api-key/v1/customers -X POST -H 'Idempotency-Key: k1' \
  -H 'Content-Type: application/x-www-form-urlencoded' -d 'name=Ann'
```

Writes act on your real accounts. Read first, and check the effect afterwards.

## MCP server

Tools: `list_apps`, `list_connections`, `api_read` (GET/HEAD only), `api_write` (POST/PUT/PATCH/DELETE,
requires a plain-language `summary`). Reads and writes are separate tools so your client can allow reads
and ask before every write. Some clients auto-approve all tools; then the split only clarifies intent.

### Key handling: read this first

A stdio MCP server gets its key from environment variables set in the client's config, so **the key ends
up in that client's config file in plain text** (or, for `claude mcp add -e`, on a command line, so in shell
history and the process list). Protect those files, prefer the forwarding options below where the client
has them, and revoke the key in the portal if it leaks. Expiring keys limit the damage.

### Claude Code

```sh
claude mcp add daho -e DAHO_API_KEY="$DAHO_API_KEY" -- npx -y @dahoai/cli mcp
```

This stores the value in Claude Code's config. (Whether Claude Code can inherit the variable instead is
not verified here.)

### Cursor

`.cursor/mcp.json` (or `~/.cursor/mcp.json`). Cursor's docs support `${env:NAME}` interpolation, so the key
can stay in your shell environment:

```json
{
  "mcpServers": {
    "daho": {
      "command": "npx",
      "args": ["-y", "@dahoai/cli", "mcp"],
      "env": { "DAHO_API_KEY": "${env:DAHO_API_KEY}" }
    }
  }
}
```

### Codex

`~/.codex/config.toml`. `env_vars` forwards a variable from Codex's own environment, so no value is
written to the file:

```toml
[mcp_servers.daho]
command = "npx"
args = ["-y", "@dahoai/cli", "mcp"]
env_vars = ["DAHO_API_KEY"]
```

## Security notes

- The key is held by one module and sent only to the gateway. Tools take an app and a path, never a URL.
- Redirects are not followed. There are no automatic retries (a repeated write can act twice).
- Headers `Authorization`, `Host`, `Cookie` and similar cannot be set by callers.
- Results over 100,000 characters are cut with a notice; binary bodies are described, not dumped.
- A key can do anything the connected apps allow. Keep keys short-lived and revoke unused ones.

## Development

```sh
npm ci
npm test          # builds, then runs unit, integration and end-to-end tests
npm run typecheck
```
