# Cursor Provider Design Specification

**Date:** 2026-03-31  
**Author:** anyclaude team  
**Status:** Approved

## Overview

This document specifies the design for adding Cursor provider support to anyclaude. The implementation enables users to run Claude Code with Cursor's AI models (starting with `composer-2`) through the anyclaude proxy wrapper.

## Problem Statement

anyclaude currently supports OpenAI, Google, xAI, Azure, and Anthropic providers. Users want to use Cursor's AI models (particularly the `composer-2` model) through Claude Code, but Cursor uses a different API format (gRPC/Connect protocol) that requires authentication and protocol translation.

## Requirements

### Functional Requirements

1. **Authentication**
   - Users authenticate via OAuth 2.0 PKCE flow in browser
   - Tokens stored securely in `~/.local/share/anyclaude/cursor-auth.json`
   - Automatic token refresh when expired
   - Separate `anyclaude cursor-auth` command for authentication

2. **Model Support**
   - Initial support for `cursor/composer-2` model
   - Model naming follows existing pattern: `<provider>/<model>`
   - Easy extensibility for future Cursor models

3. **Tool Calling**
   - Full MCP tool support from initial release
   - Bidirectional conversion between Anthropic and OpenAI tool formats

4. **Proxy Architecture**
   - Bridge pattern leveraging opencode-cursor's existing proxy
   - anyclaude translates Anthropic → OpenAI format
   - opencode-cursor proxy handles OpenAI → Cursor gRPC translation

### Non-Functional Requirements

1. **Security**
   - Never commit API keys or tokens
   - Token file permissions: readable only by owner (600)
   - PKCE S256 challenge method for OAuth flow

2. **Performance**
   - Token refresh happens transparently (5-minute safety margin)
   - Minimal latency added by bridge pattern (<100ms target)

3. **Maintainability**
   - Follow existing anyclaude code conventions
   - Modular design with clear separation of concerns
   - Comprehensive error handling and debug logging

## Architecture

### High-Level Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌───────────────────┐     ┌──────────────┐
│ Claude Code │ ──→ │ anyclaude proxy  │ ──→ │ opencode-cursor   │ ──→ │ Cursor gRPC  │
│ (Anthropic) │     │ (Anthropic→OAI)  │     │ (OAI→gRPC bridge) │     │ API          │
└─────────────┘     └──────────────────┘     └───────────────────┘     └──────────────┘
                           ↓
                    ~/.local/share/
                    anyclaude/cursor-auth.json
```

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         anyclaude CLI                                │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────┐  │
│  │ main.ts     │  │ cursor-auth │  │ anthropic-proxy.ts          │  │
│  │ - CLI entry │  │ - OAuth PKCE│  │ - Format conversion         │  │
│  │ - Provider  │  │ - Token     │  │ - Stream translation        │  │
│  │   registry  │  │   storage   │  │ - Error handling            │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────────┘  │
│         ↓                ↓                      ↓                    │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │                    Cursor Provider Layer                        ││
│  ├─────────────────────────────────────────────────────────────────┤│
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐ ││
│  │  │ cursor-provider  │  │ cursor-proxy.ts  │  │ token-manager │ ││
│  │  │ - createProvider │  │ - Spawn child    │  │ - Load tokens │ ││
│  │  │ - Model mapping  │  │   process        │  │ - Refresh     │ ││
│  │  │ - Auth header    │  │ - Port mgmt      │  │ - Store tokens│ ││
│  │  │   injection      │  │ - Lifecycle      │  │ - Expiry check│ ││
│  │  └──────────────────┘  └──────────────────┘  └───────────────┘ ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Token Manager (`src/token-manager.ts`)

**Purpose:** Manage Cursor authentication tokens with secure storage and automatic refresh.

**Responsibilities:**
- Load tokens from `~/.local/share/anyclaude/cursor-auth.json`
- Save tokens after authentication or refresh
- Check token expiry and refresh when needed (5-minute safety margin)
- Set secure file permissions (600)

**API:**
```typescript
interface CursorTokens {
  accessToken: string;
  refreshToken: string;
  expires: number; // Timestamp in milliseconds
}

class TokenManager {
  constructor(private storagePath: string);
  
  // Load tokens from storage, returns null if not found
  loadTokens(): Promise<CursorTokens | null>;
  
  // Save tokens to storage with secure permissions
  saveTokens(tokens: CursorTokens): Promise<void>;
  
  // Get valid access token, refreshing if necessary
  getValidAccessToken(): Promise<string>;
  
  // Check if tokens need refresh
  needsRefresh(tokens: CursorTokens): boolean;
  
  // Refresh expired tokens
  refreshTokens(refreshToken: string): Promise<CursorTokens>;
}
```

**Storage Path Logic:**
```typescript
const storagePath = process.env.XDG_DATA_HOME
  ? path.join(process.env.XDG_DATA_HOME, 'anyclaude', 'cursor-auth.json')
  : path.join(os.homedir(), '.local', 'share', 'anyclaude', 'cursor-auth.json');
```

### 2. Cursor Auth Command (`src/cursor-auth.ts`)

**Purpose:** Handle OAuth 2.0 PKCE authentication flow for Cursor.

**Responsibilities:**
- Generate PKCE verifier and challenge
- Open browser to Cursor login URL
- Poll for authentication completion
- Exchange refresh token for access token
- Store tokens via TokenManager

**Authentication Flow:**

```typescript
// Step 1: Generate PKCE parameters
const verifier = generateRandomString(96); // base64url
const challenge = await sha256(verifier); // base64url
const uuid = crypto.randomUUID();

// Step 2: Build login URL
const loginUrl = `https://cursor.com/loginDeepControl?` +
  `challenge=${challenge}&` +
  `uuid=${uuid}&` +
  `mode=login&` +
  `redirectTarget=cli`;

// Step 3: Open browser
await open(loginUrl);

// Step 4: Poll for tokens
const tokens = await pollForTokens(uuid, verifier);

// Step 5: Store tokens
await tokenManager.saveTokens(tokens);
```

**Polling Configuration:**
- Base delay: 1000ms
- Max delay: 10000ms
- Backoff multiplier: 1.2
- Max attempts: 150

**CLI Usage:**
```bash
anyclaude cursor-auth
# Output: "Authentication successful. Tokens saved."
```

### 3. Cursor Provider (`src/cursor-provider.ts`)

**Purpose:** Create AI SDK provider for Cursor with proper authentication.

**Responsibilities:**
- Create OpenAI-compatible provider instance
- Inject Cursor access token into requests
- Map model names (`cursor/composer-2` → `composer-2`)
- Handle custom fetch with auth headers

**Implementation:**
```typescript
import { createOpenAI } from "@ai-sdk/openai";
import { TokenManager } from "./token-manager";

export function createCursorProvider() {
  const tokenManager = new TokenManager(getCursorStoragePath());
  
  return {
    provider: 'cursor',
    languageModel: (modelId: string) => {
      // Strip 'cursor/' prefix for actual API call
      const cursorModelId = modelId.replace(/^cursor\//, '');
      
      return createOpenAI({
        apiKey: 'cursor-proxy', // Dummy key, real token injected via fetch
        baseURL: 'http://localhost:<port>/v1', // opencode-cursor proxy
        fetch: async (url, init) => {
          const accessToken = await tokenManager.getValidAccessToken();
          
          // Inject real access token
          const headers = {
            ...init?.headers,
            Authorization: `Bearer ${accessToken}`,
          };
          
          return globalThis.fetch(url, { ...init, headers });
        },
      }).languageModel(cursorModelId);
    },
  };
}
```

### 4. Cursor Proxy (`src/cursor-proxy.ts`)

**Purpose:** Spawn and manage opencode-cursor proxy as a child process.

**Responsibilities:**
- Download or locate opencode-cursor binary
- Spawn proxy process on random available port
- Wait for proxy to be ready
- Provide proxy URL to provider
- Handle proxy lifecycle (cleanup on exit)

**Implementation:**
```typescript
import { spawn } from "child_process";
import { createServer } from "http";

export async function startCursorProxy(): Promise<{
  url: string;
  stop: () => Promise<void>;
}> {
  // Find available port
  const port = await getAvailablePort();
  
  // Spawn opencode-cursor proxy
  const proxy = spawn('opencode-cursor', ['--port', port.toString()], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  
  // Wait for proxy to be ready
  await waitForProxy(port);
  
  return {
    url: `http://localhost:${port}`,
    stop: async () => {
      proxy.kill();
    },
  };
}
```

**Note:** This requires opencode-cursor to be installed separately, or we bundle a vendored version.

### 5. Main CLI Updates (`src/main.ts`)

**Purpose:** Integrate Cursor provider into anyclaude CLI.

**Changes:**

1. **Add Cursor to provider registry:**
```typescript
const providers: CreateAnthropicProxyOptions["providers"] = {
  // ... existing providers
  cursor: createCursorProvider(),
};
```

2. **Add cursor-auth command:**
```typescript
if (args._[0] === 'cursor-auth') {
  await runCursorAuth();
  process.exit(0);
}
```

3. **Start cursor proxy when cursor model is requested:**
```typescript
if (modelParts[0] === 'cursor') {
  const { url, stop } = await startCursorProxy();
  process.on('exit', stop);
  process.on('SIGINT', () => { stop(); process.exit(130); });
  process.on('SIGTERM', () => { stop(); process.exit(143); });
}
```

## Data Flow

### Authentication Flow

```
User runs: anyclaude cursor-auth
         ↓
Generate PKCE verifier + challenge
         ↓
Open browser: cursor.com/loginDeepControl?challenge=...&uuid=...
         ↓
User completes OAuth in browser
         ↓
Poll: api2.cursor.sh/auth/poll?uuid=...&verifier=...
         ↓
Receive: { accessToken, refreshToken }
         ↓
Save to: ~/.local/share/anyclaude/cursor-auth.json (mode 600)
         ↓
Output: "Authentication successful. Tokens saved."
```

### Request Flow (Chat Completion)

```
Claude Code: POST /v1/messages { model: "cursor/composer-2", ... }
         ↓
anyclaude proxy: Parse model = "cursor/composer-2"
         ↓
Extract provider = "cursor", modelId = "composer-2"
         ↓
Convert Anthropic format → AI SDK format
         ↓
Get valid access token (refresh if needed)
         ↓
POST http://localhost:<port>/v1/chat/completions
     Headers: Authorization: Bearer <access_token>
     Body: { model: "composer-2", ... } (OpenAI format)
         ↓
opencode-cursor proxy: Convert OpenAI → Cursor gRPC
         ↓
Cursor API: Process request
         ↓
Response flows back through chain (gRPC → OpenAI → Anthropic)
         ↓
Claude Code receives Anthropic-format response
```

## Error Handling

### Authentication Errors

| Error | Handling |
|-------|----------|
| Token not found | Prompt user to run `anyclaude cursor-auth` |
| Token expired + refresh fails | Prompt user to re-authenticate |
| Poll timeout (150 attempts) | Show error: "Authentication timeout. Please try again." |
| Invalid PKCE challenge | Show error: "Authentication failed. Please try again." |

### Proxy Errors

| Error | Handling |
|-------|----------|
| opencode-cursor not found | Show error: "opencode-cursor not installed. Run: npm install -g opencode-cursor" |
| Port already in use | Try next available port (max 3 attempts) |
| Proxy fails to start | Show error with stderr output, exit code 1 |
| Proxy crashes during use | Show error, graceful shutdown, exit code 1 |

### API Errors

| Error | Handling |
|-------|----------|
| 401 Unauthorized | Refresh token, retry once, then prompt re-auth |
| 429 Rate limit | Pass through to Claude Code for retry |
| 500 Server error | Pass through to Claude Code for retry |
| Network error | Retry with exponential backoff (3 attempts) |

## Testing Strategy

### Unit Tests

1. **TokenManager**
   - Load/save tokens
   - Token expiry detection
   - Token refresh logic
   - File permission setting

2. **cursor-auth**
   - PKCE parameter generation
   - Login URL construction
   - Poll backoff logic

3. **cursor-provider**
   - Model name mapping
   - Auth header injection
   - Error handling

### Integration Tests

1. **Authentication flow** (gated behind `CURSOR_TEST_AUTH` env var)
   - Full OAuth flow (mocked browser)
   - Token refresh cycle

2. **Proxy lifecycle** (gated behind `CURSOR_TEST_PROXY` env var)
   - Start/stop proxy
   - Port management

3. **End-to-end** (gated behind `CURSOR_TEST_E2E` env var)
   - Simple chat completion
   - Tool calling round-trip

## Security Considerations

1. **Token Storage**
   - File permissions: 600 (owner read/write only)
   - Never log tokens
   - Clear tokens from memory after use

2. **OAuth Flow**
   - PKCE S256 challenge method (required)
   - Secure random generation for verifier
   - State parameter for CSRF protection

3. **Network**
   - All communication over HTTPS
   - Local proxy only accessible on localhost
   - No token forwarding in headers

## Dependencies

### New Dependencies

```json
{
  "dependencies": {
    "open": "^9.1.0",  // Open browser for OAuth
    "pkce-challenge": "^4.1.0"  // PKCE generation (optional, can implement ourselves)
  }
}
```

### External Requirements

- **opencode-cursor**: Must be installed separately or vendored
  - Option 1: Document as prerequisite (`npm install -g opencode-cursor`)
  - Option 2: Bundle as binary dependency
  - Option 3: Download on first use from GitHub releases

**Recommendation:** Start with Option 1 (document as prerequisite), revisit bundling in future iteration.

## Migration Path

### Future Enhancements

1. **Multiple Model Support**
   - Call `GetUsableModels` RPC at startup
   - Dynamically register available models
   - Model mapping: `cursor/<displayModelId>`

2. **Direct gRPC Implementation**
   - Replace opencode-cursor bridge with native gRPC client
   - Benefits: Better control, fewer dependencies
   - Cost: Significant implementation effort

3. **Token Management Improvements**
   - Support multiple Cursor accounts
   - CLI command to view/clear tokens
   - Automatic token cleanup on expiry

## Rollout Plan

### Phase 1: Core Implementation (Week 1)
- TokenManager implementation
- cursor-auth command
- Basic cursor-provider (text-only)
- Documentation updates

### Phase 2: Tool Support (Week 2)
- Full tool calling implementation
- Integration testing
- Error handling improvements

### Phase 3: Polish & Release (Week 3)
- Debug logging
- Performance optimization
- User testing
- Release announcement

## Success Criteria

1. **Functional**
   - User can authenticate with `anyclaude cursor-auth`
   - User can run `anyclaude --model cursor/composer-2`
   - Tool calling works correctly
   - Token refresh is transparent

2. **Performance**
   - Authentication completes in <30 seconds
   - Proxy adds <100ms latency
   - Token refresh is seamless

3. **User Experience**
   - Clear error messages
   - Helpful documentation
   - No manual token management required

---

## Appendix A: File Locations

```
~/.local/share/anyclaude/
├── cursor-auth.json    # Cursor OAuth tokens
└── debug/              # Debug logs (if ANYCLAUDE_DEBUG set)
```

## Appendix B: Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `XDG_DATA_HOME` | Base directory for token storage | `~/.local/share` |
| `CURSOR_API_URL` | Override Cursor API endpoint | `https://api2.cursor.sh` |
| `ANYCLAUDE_DEBUG` | Enable debug logging | `0` |

## Appendix C: Example Commands

```bash
# Authenticate with Cursor
anyclaude cursor-auth

# Run Claude Code with Cursor
anyclaude --model cursor/composer-2

# With debug logging
ANYCLAUDE_DEBUG=1 anyclaude --model cursor/composer-2

# Custom token storage location
XDG_DATA_HOME=/custom/path anyclaude cursor-auth
```
