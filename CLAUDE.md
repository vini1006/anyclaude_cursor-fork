# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

anyclaude wraps the `claude` CLI: it starts a local HTTP server that implements the Anthropic Messages API surface Claude Code expects, forwards traffic through the Vercel AI SDK to configured providers, and runs `claude` with `ANTHROPIC_BASE_URL` pointing at that server. Model IDs look like `<provider>/<model>` (for example `openai/gpt-5-mini`): the segment before the first `/` selects a key in the proxy `providers` map in `src/main.ts`; the remainder is the provider-specific model name. README notes compatibility with Claude Code GitHub Actions.

## Architecture

1. **`src/main.ts`** — Parses and strips anyclaude-only flags (`--reasoning-effort` / `-e`, `--service-tier` / `-t`) from argv before spawning `claude`, validates allowed values, and builds the `providers` map (`openai`, `azure`, `google`, `xai`, optional `anthropic` when `ANTHROPIC_API_KEY` is set). The OpenAI client uses a custom `fetch` that maps `max_tokens` → `max_completion_tokens`, sets `reasoning` (`summary: "auto"`, plus `reasoning.effort` when `-e` is set), and applies `service_tier` when `-t` is set. On normal runs it **`await`s `initializeCursorProvider`**, which starts the Cursor forwarder (`startCursorProxy`), registers `cursor` with `createCursorProviderWithBaseUrl`, and wires shutdown on exit signals—this runs even when you are not using a `cursor/*` model. Then **`createAnthropicProxy`** returns the local base URL. Unless `PROXY_ONLY=true`, it **`spawn`s `claude`** with `ANTHROPIC_BASE_URL` set. Subcommand **`cursor-auth`** is handled here and does not start the proxy.

2. **`src/anthropic-proxy.ts`** — HTTP server: accept Anthropic-shaped request bodies, convert them for the AI SDK, run **`streamText`** (including tools / JSON schemas), stream responses through **`convert-to-anthropic-stream`**, and map some provider errors into Anthropic-like errors so Claude Code's retry behavior stays sensible.

3. **Conversion layer** — `convert-anthropic-messages`, `convert-to-language-model-prompt`, `convert-to-anthropic-stream`, `json-schema`, and `anthropic-api-types` bridge Anthropic messages, tools, cache details, and streaming events to what the AI SDK expects. Message-shape, tool, or streaming bugs usually need coordinated changes in this layer **and** the proxy.

4. **Cursor** — `src/cursor-auth.ts`, `src/cursor-proxy.ts`, `src/cursor-provider.ts`, and `src/token-manager.ts` integrate with `main.ts`. `startCursorProxy` builds the server from `src/cursor/proxy/` (HTTP handler and request formatting); `src/cursor/streaming/` parses OpenAI-style SSE from Cursor's side of the conversation. OAuth/PKCE, RPC, client calls, and model metadata live in the remaining `src/cursor/*.ts` modules. `createCursorProvider` registers Cursor with the AI SDK (defaults to **proxy** mode against that local server; a **direct** code path exists for alternate wiring).

There are no checked-in Cursor rules (`.cursor/rules`, `.cursorrules`) or `.github/copilot-instructions.md` in this repository.

## Commands

Uses **Bun** for installs and scripts. **Lint:** no ESLint; use **`bun run typecheck`** for types and **Prettier** for formatting (`bun run fmt` to write, `bunx prettier --check .` to verify). Tests use **Bun’s test runner** (`bun test`). **`typescript`** is a peer dependency (^5).

```bash
bun install                          # dependencies
bun run build                        # dist/main.cjs + shebanged executable dist/main.js
bun run typecheck                    # tsc --noEmit
bun run test                         # all tests (same as bun test)
bun test src/path/to/file.test.ts    # single file
bun test -t "pattern"                # filter by test name
bun test --watch                     # re-run tests on file changes
bun run fmt                          # Prettier --write .
bunx prettier --check .              # format check (no writes)
bun run install:global               # build, npm pack, npm install -g tarball
```

End-user install of the published package is described in README (e.g. `pnpm install -g anyclaude`); use `bun install` when developing in this repo. Optional Nix/direnv shell: `direnv allow` or `nix develop`; format Nix/shell with `nix fmt` (see `AGENTS.md`).

Develop against source:

```bash
bun run src/main.ts [args...]
bun run src/main.ts cursor-auth
```

After build, same as published entry:

```bash
bun run ./dist/main.js [args...]
```

## Manual checks

```bash
PROXY_ONLY=true bun run src/main.ts    # logs proxy URL; does not spawn claude
OPENAI_API_KEY=... bun run src/main.ts --model openai/gpt-5-mini
```

## Environment and user-facing behavior (README + `main.ts`)

- **Keys / base URLs:** `OPENAI_*`, `AZURE_*`, `GOOGLE_*`, `XAI_*` (each supports `*_API_KEY` and optional `*_API_URL`). **`ANTHROPIC_API_KEY`** (optional `ANTHROPIC_API_URL`) registers the real Anthropic provider as `anthropic`; if unset, `anthropic` is not in the map.
- **Cursor:** `CURSOR_OAUTH_TOKEN` for `cursor/*`; `anyclaude cursor-auth` runs OAuth; tokens are stored under `~/.local/share/opencode/auth.json` (see README).
- **Claude UI:** switch models with `/model <provider>/<model>`.
- **GPT-5-oriented flags:** `--reasoning-effort` (`-e`: minimal, low, medium, high), `--service-tier` (`-t`: flex, priority). README notes these may apply to other providers later.
- **Custom OpenAI-compatible endpoints:** `OPENAI_API_URL` (e.g. OpenRouter).
- **`ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_MODEL`:** support `<provider>/...` syntax (README).
- **Runtime:** `PROXY_ONLY=true` proxy-only mode; `ANYCLAUDE_DEBUG=1|2` logging in `src/debug.ts`.

For which environment variables register which provider keys, treat the **`providers` object in `src/main.ts`** as authoritative (README links there; line numbers drift).
