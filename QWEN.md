# anyclaude - Project Context

## Project Overview

**anyclaude** is a proxy wrapper for Claude Code that enables using alternative LLM providers (OpenAI, Google, xAI, Azure) through the Anthropic API format. It intercepts Anthropic API calls and translates them to/from the Vercel AI SDK format for the specified provider.

### Architecture

The proxy works by:

1. Spawning a local HTTP server that mimics the Anthropic API
2. Intercepting `/v1/messages` requests containing `<provider>/<model>` format (e.g., `openai/gpt-5-mini`)
3. Converting Anthropic message format to AI SDK format
4. Routing to the appropriate provider (OpenAI, Google, xAI, Azure)
5. Converting responses back to Anthropic format
6. Setting `ANTHROPIC_BASE_URL` to point Claude Code at the proxy

### Key Components

| File | Purpose |
|------|---------|
| `src/main.ts` | CLI entry point; parses flags, sets up providers, spawns Claude with proxy |
| `src/anthropic-proxy.ts` | HTTP server handling request/response translation and streaming |
| `src/convert-anthropic-messages.ts` | Bidirectional message format conversion between Anthropic and AI SDK |
| `src/convert-to-anthropic-stream.ts` | Stream response conversion |
| `src/convert-to-language-model-prompt.ts` | Converts AI SDK prompts to Anthropic format |
| `src/json-schema.ts` | Schema adaptation for different providers (handles format differences) |
| `src/anthropic-api-types.ts` | TypeScript type definitions for Anthropic API structures |
| `src/debug.ts` | Debug logging utilities with file-based error dumps |
| `src/claude-config.ts` | Reads Claude Code API key from user config |

### Supported Providers

- **OpenAI** (`openai/*`) - via `OPENAI_API_KEY`
- **Google** (`google/*`) - via `GOOGLE_API_KEY`
- **xAI** (`xai/*`) - via `XAI_API_KEY`
- **Azure** (`azure/*`) - via `AZURE_API_KEY`
- **Anthropic** (`anthropic/*`) - via `ANTHROPIC_API_KEY` (passthrough)

## Building and Running

### Prerequisites

- Bun runtime (primary) or Node.js 22+
- Claude Code CLI installed (`claude` command)
- API keys for desired providers

### Commands

```bash
# Install dependencies
bun install

# Build the project (creates dist/main.js with Node shebang)
bun run build

# Run type checking
bun run typecheck

# Format code with Prettier
bun run fmt

# Run tests (Bun test runner)
bun run test

# Install globally (after build)
bun run install:global
```

### Running the CLI

```bash
# Development mode (no build required)
OPENAI_API_KEY=your-key bun run src/main.ts --model openai/gpt-5-mini

# Proxy-only mode (prints proxy URL without spawning Claude)
PROXY_ONLY=true bun run src/main.ts

# After build
./dist/main.js --model openai/gpt-5-mini

# With reasoning effort (OpenAI only)
./dist/main.js --model openai/gpt-5-mini -e high

# With service tier (OpenAI only)
./dist/main.js --model openai/gpt-5-mini -t priority
```

### Debug Mode

Set `ANYCLAUDE_DEBUG` environment variable for detailed logging:

```bash
# Basic debug (level 1)
ANYCLAUDE_DEBUG=1 bun run src/main.ts --model openai/gpt-5-mini

# Verbose debug (level 2) - includes full stream dumps
ANYCLAUDE_DEBUG=2 bun run src/main.ts --model openai/gpt-5-mini
```

Debug files are written to:
- Error logs: `/tmp/anyclaude-errors.log`
- Detailed dumps: `/tmp/anyclaude-debug-*.json`

## Development Conventions

### Code Style

- **Language**: TypeScript (ESNext, strict mode enabled)
- **Indentation**: 2 spaces
- **Files**: kebab-case `.ts` (e.g., `convert-to-anthropic-stream.ts`)
- **Naming**: `camelCase` for variables/functions; `PascalCase` for types/classes
- **Exports**: Prefer named exports; keep modules single-purpose and small
- **Imports**: Use explicit imports with `verbatimModuleSyntax`

### Testing Practices

- **Framework**: Bun test runner (`bun:test`)
- **Location**: `src/**/*.test.ts` (alongside source files)
- **Focus**: Pure units (converters, schema, MIME detection)
- **Avoid**: Live provider calls (gate with env vars if needed)

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | OpenAI API authentication |
| `OPENAI_API_URL` | Custom OpenAI endpoint (e.g., OpenRouter) |
| `GOOGLE_API_KEY` | Google AI API authentication |
| `XAI_API_KEY` | xAI API authentication |
| `AZURE_API_KEY` | Azure OpenAI authentication |
| `ANTHROPIC_API_KEY` | Anthropic API authentication (optional passthrough) |
| `PROXY_ONLY=true` | Run proxy without spawning Claude Code |
| `ANYCLAUDE_DEBUG=1\|2` | Enable debug logging (1=basic, 2=verbose) |

### Nix Development Shell

The project includes a Nix flake for reproducible development:

```bash
# Enter development shell
direnv allow  # or: nix develop

# Format Nix/shell files
nix fmt
```

## Key Implementation Details

### Model Name Parsing

Models are specified as `<provider>/<model-name>`. The proxy splits on `/` to determine:
- Provider name (first segment)
- Model name (remaining segments)

Example: `openai/gpt-5-mini` → provider: `openai`, model: `gpt-5-mini`

### Error Handling

The proxy implements sophisticated error handling:

1. **Non-streaming errors**: Transformed to Anthropic-compatible format with appropriate HTTP status codes
2. **Streaming errors**: Converted to Anthropic `event: error` format with full debug dumps
3. **OpenAI-specific**: Server errors transformed to 429 rate limit errors to trigger Claude Code's automatic retry
4. **Context length errors**: Transformed to `request_too_large` format (413) to prevent futile retries

### Stream Processing

Streaming responses are converted using `convertToAnthropicStream()`, which:
- Maps AI SDK stream events to Anthropic SSE format
- Handles tool calls, text deltas, and reasoning content
- Collects chunks for debug dumps when verbose mode is enabled

### Schema Adaptation

The `providerizeSchema()` function handles provider-specific JSON Schema differences:
- **OpenAI**: Adds `additionalProperties: false`, removes `format: "uri"`
- **Google**: Removes `format: "uri"`
- Preserves original schema intent where possible

## Related Files

- `README.md` - User-facing documentation
- `CLAUDE.md` - Claude Code-specific guidance
- `AGENTS.md` - Repository guidelines for AI agents
- `package.json` - Build scripts, dependencies, Prettier config
- `tsconfig.json` - TypeScript configuration (strict mode, ESNext)
- `flake.nix` - Nix development environment definition
