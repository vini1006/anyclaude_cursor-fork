# Cursor API Specification

This document describes the API specifications used in the opencode-cursor plugin, which enables OpenCode to connect to Cursor's AI models.

---

## Table of Contents

1. [Overview](#overview)
2. [Authentication API](#authentication-api)
3. [Model Discovery API](#model-discovery-api)
4. [Chat Completion API](#chat-completion-api)
5. [gRPC/Connect Protocol](#grpcconnect-protocol)
6. [Data Models](#data-models)

---

## Overview

### Architecture

```
OpenCode  →  Local Proxy (OpenAI-compatible)  →  HTTP/2 Bridge  →  Cursor gRPC API
           (Bun.serve on localhost)            (Node.js child)    (api2.cursor.sh)
```

### Base URLs

| Environment | URL |
|-------------|-----|
| Production | `https://api2.cursor.sh` |
| Login | `https://cursor.com/loginDeepControl` |

---

## Authentication API

### OAuth 2.0 PKCE Flow

The plugin uses PKCE (Proof Key for Code Exchange) for secure browser-based authentication.

#### Step 1: Generate Auth Parameters

**Client-side generation:**

```typescript
import { generatePKCE } from "./pkce";

const verifierBytes = new Uint8Array(96);
crypto.getRandomValues(verifierBytes);
const verifier = Buffer.from(verifierBytes).toString("base64url");

const challenge = await crypto.subtle.digest("SHA-256", verifier);
const challengeB64 = Buffer.from(hashBuffer).toString("base64url");
const uuid = crypto.randomUUID();
```

**Output:**
- `verifier`: 96-byte random string (base64url)
- `challenge`: SHA-256 hash of verifier (base64url)
- `uuid`: Unique session identifier

#### Step 2: Login URL

**Endpoint:** `GET https://cursor.com/loginDeepControl`

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `challenge` | string | PKCE challenge (base64url) |
| `uuid` | string | Session UUID |
| `mode` | string | Always `"login"` |
| `redirectTarget` | string | Always `"cli"` |

**Example:**
```
https://cursor.com/loginDeepControl?challenge=ABC123&uuid=550e8400-e29b-41d4-a716-446655440000&mode=login&redirectTarget=cli
```

#### Step 3: Poll for Tokens

**Endpoint:** `GET https://api2.cursor.sh/auth/poll`

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `uuid` | string | Session UUID from Step 1 |
| `verifier` | string | PKCE verifier from Step 1 |

**Response Codes:**
- `404`: User has not completed authentication (continue polling)
- `200`: Authentication successful

**Success Response:**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "dGhpc2lzYXJlZnJlc2h0b2tlbg..."
}
```

**Polling Configuration:**
- Base delay: 1000ms
- Max delay: 10000ms
- Backoff multiplier: 1.2
- Max attempts: 150

#### Step 4: Token Refresh

**Endpoint:** `POST https://api2.cursor.sh/auth/exchange_user_api_key`

**Headers:**
```
Authorization: Bearer <refreshToken>
Content-Type: application/json
```

**Body:**
```json
{}
```

**Response:**
```json
{
  "accessToken": "new_access_token",
  "refreshToken": "new_refresh_token"
}
```

### Token Structure

Access tokens are JWTs with the following structure:
- Header: Standard JWT header
- Payload: Contains `exp` (expiry timestamp in seconds)
- Signature: RS256 or HS256

**Token Expiry Calculation:**
```typescript
const expiry = decoded.exp * 1000 - (5 * 60 * 1000); // 5-minute safety margin
```

---

## Model Discovery API

### Get Usable Models

**RPC Path:** `/agent.v1.AgentService/GetUsableModels`

**Protocol:** Connect (gRPC-compatible)

**Request:**
```protobuf
message GetUsableModelsRequest {}
```

**Response:**
```protobuf
message GetUsableModelsResponse {
  repeated ModelDetails models = 1;
}

message ModelDetails {
  string modelId = 1;
  string displayModelId = 3;
  string displayName = 4;
  string displayNameShort = 5;
  repeated string aliases = 6;
  ThinkingDetails thinkingDetails = 2;
}
```

**Response Encoding:**
- Content-Type: `application/connect+proto`
- Binary protobuf with Connect framing

**Fallback Models:**
If model discovery fails, the plugin uses a hardcoded list:

| Model ID | Name | Reasoning | Context | Max Tokens |
|----------|------|-----------|---------|------------|
| `composer-1` | Composer 1 | Yes | 200K | 64K |
| `composer-1.5` | Composer 1.5 | Yes | 200K | 64K |
| `claude-4.6-opus-high` | Claude 4.6 Opus | Yes | 200K | 128K |
| `claude-4.6-sonnet-medium` | Claude 4.6 Sonnet | Yes | 200K | 64K |
| `gpt-5.4-medium` | GPT-5.4 | Yes | 272K | 128K |
| `gemini-3.1-pro` | Gemini 3.1 Pro | Yes | 1M | 64K |

---

## Chat Completion API

### Local Proxy Endpoint

The plugin exposes an OpenAI-compatible local proxy:

**Base URL:** `http://localhost:<port>/v1`

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/models` | List available models |
| `POST` | `/v1/chat/completions` | Create chat completion |

#### List Models

**Request:**
```
GET /v1/models
Authorization: Bearer cursor-proxy
```

**Response:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "claude-4.6-sonnet",
      "object": "model",
      "created": 0,
      "owned_by": "cursor"
    }
  ]
}
```

#### Create Chat Completion

**Request:**
```
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer cursor-proxy
```

**Body:**
```json
{
  "model": "claude-4.6-sonnet",
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful assistant."
    },
    {
      "role": "user",
      "content": "Hello!"
    }
  ],
  "stream": true,
  "temperature": 0.7,
  "max_tokens": 4096,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "Read a file",
        "parameters": {
          "type": "object",
          "properties": {
            "path": { "type": "string" }
          }
        }
      }
    }
  ]
}
```

**Streaming Response (SSE):**
```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"claude-4.6-sonnet","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"claude-4.6-sonnet","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"claude-4.6-sonnet","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_123","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"test.txt\"}"}}]},"finish_reason":null}]}

data: [DONE]
```

---

## gRPC/Connect Protocol

### Agent Run RPC

**RPC Path:** `/agent.v1.AgentService/Run`

**Protocol:** Connect Streaming (`application/connect+proto`)

**Headers:**
```
:method: POST
:path: /agent.v1.AgentService/Run
content-type: application/connect+proto
te: trailers
authorization: Bearer <access_token>
x-ghost-mode: true
x-cursor-client-version: cli-2026.01.09-231024f
x-cursor-client-type: cli
x-request-id: <uuid>
connect-protocol-version: 1
```

### Connect Framing

Each message is framed as:
```
[1 byte flags][4 bytes big-endian length][payload]
```

**Flags:**
- Bit 0 (0x01): Compressed
- Bit 1 (0x02): End of stream

**Example Frame:**
```
00 00 00 00 2A <42 bytes of protobuf data>
```

### Request Message

```protobuf
message AgentClientMessage {
  oneof message {
    AgentRunRequest runRequest = 1;
    ExecClientMessage execClientMessage = 2;
    KvClientMessage kvClientMessage = 3;
    ClientHeartbeat clientHeartbeat = 4;
  }
}

message AgentRunRequest {
  ConversationStateStructure conversationState = 1;
  ConversationAction action = 2;
  ModelDetails modelDetails = 3;
  string conversationId = 5;
  repeated McpToolDefinition mcpTools = 4;
}
```

### Response Messages

```protobuf
message AgentServerMessage {
  oneof message {
    InteractionUpdate interactionUpdate = 1;
    TokenDeltaUpdate tokenDeltaUpdate = 8;
    ToolCallStartedUpdate toolCallStarted = 2;
    ToolCallCompletedUpdate toolCallCompleted = 3;
    ToolCallDeltaUpdate toolCallDelta = 15;
    ThinkingDeltaUpdate thinkingDelta = 4;
    ThinkingCompletedUpdate thinkingCompleted = 5;
    HeartbeatUpdate heartbeat = 13;
    TurnEndedUpdate turnEnded = 14;
  }
}
```

### Tool Calling Flow

1. **OpenAI → Proxy:** Send tool definitions in `tools` array
2. **Proxy → Cursor:** Convert to `McpToolDefinition` in `RequestContext`
3. **Cursor → Proxy:** Model requests tool via `mcpArgs` exec message
4. **Proxy → OpenAI:** Emit `tool_calls` SSE chunk, pause stream
5. **OpenCode:** Execute tool, send result in follow-up request
6. **Proxy → Cursor:** Resume with `mcpResult`, continue streaming

**Tool Rejection Types:**
- `ReadRejected` - File read not allowed
- `WriteRejected` - File write not allowed
- `ShellRejected` - Shell execution not allowed
- `LsRejected` - Directory listing not allowed
- `GrepRejected` - Grep search not allowed

---

## Data Models

### Authentication

```typescript
interface CursorAuthParams {
  verifier: string;      // PKCE verifier (base64url)
  challenge: string;     // PKCE challenge (base64url)
  uuid: string;          // Session UUID
  loginUrl: string;      // Full login URL with query params
}

interface CursorCredentials {
  access: string;        // JWT access token
  refresh: string;       // Refresh token
  expires: number;       // Expiry timestamp (ms)
}
```

### Models

```typescript
interface CursorModel {
  id: string;           // Model identifier (e.g., "claude-4.6-sonnet")
  name: string;         // Display name
  reasoning: boolean;   // Supports reasoning/thinking
  contextWindow: number; // Context size in tokens
  maxTokens: number;    // Max output tokens
}
```

### Pricing (USD per 1M tokens)

| Model Family | Input | Output | Cache Read | Cache Write |
|--------------|-------|--------|------------|-------------|
| Claude Opus | $5 | $25 | $0.50 | $6.25 |
| Claude Sonnet | $3 | $15 | $0.30 | $3.75 |
| Claude Haiku | $1 | $5 | $0.10 | $1.25 |
| GPT-5 | $1.25 | $10 | $0.125 | $0 |
| GPT-5 Mini | $0.25 | $2 | $0.025 | $0 |
| Gemini 3 Pro | $2 | $12 | $0.20 | $0 |
| Composer | $0.50-$3.50 | $2.50-$17.50 | $0.05-$0.35 | $0 |

### Conversation State

```protobuf
message ConversationStateStructure {
  repeated bytes rootPromptMessagesJson = 1;
  repeated bytes turns = 8;
  repeated TodoItem todos = 3;
  repeated string pendingToolCalls = 4;
  repeated string previousWorkspaceUris = 17;
  map<string, FileState> fileStates = 10;
  map<string, FileStateStructure> fileStatesV2 = 15;
  repeated ConversationSummaryArchive summaryArchives = 11;
  repeated StepTiming turnTimmings = 14;
  map<string, SubagentPersistedState> subagentStates = 16;
  int32 selfSummaryCount = 18;
  repeated string readPaths = 19;
}
```

### MCP Tool Definition

```protobuf
message McpToolDefinition {
  string name = 1;
  string description = 2;
  string providerIdentifier = 3;
  string toolName = 4;
  bytes inputSchema = 5;  // Protobuf Value (JSON schema)
}
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CURSOR_API_URL` | `https://api2.cursor.sh` | Cursor API base URL |
| `CURSOR_REFRESH_URL` | `https://api2.cursor.sh/auth/exchange_user_api_key` | Token refresh endpoint |

---

## Error Handling

### Authentication Errors

| Status | Description | Action |
|--------|-------------|--------|
| 401 | Invalid/expired token | Refresh token |
| 403 | Invalid refresh token | Re-authenticate |
| 404 | Poll: user not authenticated | Continue polling |

### gRPC Errors

```protobuf
message FetchError {
  string error = 1;
}

message McpError {
  string error = 1;
}

message GrepError {
  string error = 1;
}
```

### Connect End Stream Error

```json
{
  "error": {
    "code": "internal",
    "message": "Error description"
  }
}
```

---

## Rate Limits & Timeouts

| Operation | Limit |
|-----------|-------|
| Auth polling | 150 attempts max |
| Token refresh | No explicit limit |
| Model discovery | Cached after first call |
| Conversation state | 30-minute TTL |
| Bridge idle timeout | 120 seconds |
| Proxy idle timeout | 255 seconds |

---

## Security Considerations

1. **PKCE:** All OAuth flows use PKCE S256 challenge method
2. **Token Storage:** Tokens stored in `~/.local/share/opencode/auth.json`
3. **Token Refresh:** Automatic refresh 5 minutes before expiry
4. **Local Proxy:** Only accessible on localhost (no external exposure)
5. **Authorization Header:** Stripped from proxied requests to prevent leakage
