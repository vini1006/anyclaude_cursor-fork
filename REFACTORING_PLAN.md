# Cursor Logic Refactoring Plan

## Overview

This plan outlines the refactoring of cursor-related logic in `anyclaude_cursor-fork` using the architecture and patterns from `opencode-cursor-1` as a reference.

## Current Architecture Analysis

### anyclaude_cursor-fork (Current)

**Auth Flow:**
- PKCE-based OAuth flow with browser login
- Polls `https://api2.cursor.sh/auth/poll` for tokens
- Stores tokens in `~/.local/share/anyclaude/cursor-auth.json`
- Token refresh via `exchange_user_api_key` endpoint
- **Issue**: Complex PKCE flow, direct API polling

**Proxy Architecture:**
- Uses gRPC/Connect protocol via HTTP/2 bridge (Node subprocess)
- Translates OpenAI format → Cursor protobuf → gRPC
- Manages conversation state with checkpointing
- Tool calling via MCP protocol
- **Issues**: 
  - Complex protobuf handling (15K+ lines of generated code)
  - HTTP/2 bridge requires Node subprocess (Bun's http2 is broken)
  - Conversation state management is complex
  - Active bridge management across requests

**Provider:**
- Uses `@ai-sdk/openai` with custom fetch interceptor
- Injects auth headers via TokenManager
- Depends on local proxy running on `localhost:0` (auto port)

---

### opencode-cursor-1 (Reference)

**Auth Flow:**
- Spawns `cursor-agent login` subprocess
- Extracts OAuth URL from stdout
- Polls for auth file (`cli-config.json` or `auth.json`)
- Auth file location: `~/.cursor/` or `~/.config/cursor/`
- **Benefits**: Simpler, delegates auth to cursor-agent, no PKCE handling

**Proxy Architecture:**
- Uses `cursor-agent --output-format stream-json` subprocess
- NDJSON stream parsing
- OpenAI-compatible HTTP server (Bun.serve)
- Tool extraction from stream events
- **Benefits**:
  - No protobuf/gRPC complexity
  - No HTTP/2 bridge needed
  - Simpler stream parsing (NDJSON vs Connect protocol)
  - Per-request process spawning (no state management)

**Provider:**
- Direct mode: Uses SimpleCursorClient (spawns cursor-agent)
- Proxy mode: HTTP proxy with OpenAI-compatible API
- AI SDK compatible with `doGenerate`/`doStream`
- Tool call interception via ACP (Agent Client Protocol)

---

## Key Architectural Differences

| Aspect | anyclaude_cursor-fork | opencode-cursor-1 |
|--------|----------------------|-------------------|
| **Auth** | PKCE OAuth, direct API | `cursor-agent login`, file polling |
| **Transport** | gRPC/Connect over HTTP/2 | NDJSON stream over stdin/stdout |
| **Protocol** | Protocol buffers (generated) | JSON line protocol |
| **Process Model** | Long-lived HTTP/2 bridge | Per-request cursor-agent spawn |
| **State Management** | Conversation checkpoints | Stateless (per-request) |
| **Tool Calling** | MCP protocol via protobuf | Stream event extraction |
| **Complexity** | High (protobuf, gRPC, HTTP/2) | Low (JSON, subprocess) |

---

## Refactoring Strategy

### Phase 1: Authentication Refactoring

**Goal**: Simplify auth by delegating to `cursor-agent` CLI

**Changes:**
1. Replace `cursor-auth.ts` PKCE flow with `cursor-agent login` spawning
2. Update `token-manager.ts` to read from `~/.cursor/cli-config.json`
3. Remove PKCE generation and polling logic
4. Support both legacy (`auth.json`) and current (`cli-config.json`) formats

**Files to Modify:**
- `src/cursor-auth.ts` - Rewrite to use `cursor-agent login`
- `src/token-manager.ts` - Add support for cursor's native auth file format
- `src/cursor/cursor-pkce.ts` - Can be removed (or kept for backward compatibility)

**New File Structure:**
```
src/
  cursor-auth.ts       # Rewritten: spawn cursor-agent login
  token-manager.ts     # Modified: read ~/.cursor/cli-config.json
  cursor/
    cursor-pkce.ts     # Deprecated (keep for backward compat)
```

---

### Phase 2: Proxy Refactoring

**Goal**: Replace gRPC/protobuf with NDJSON stream parsing

**Changes:**
1. Replace `cursor-proxy-internal.ts` with simpler NDJSON-based proxy
2. Remove protobuf dependencies (`agent_pb.ts` - 15K lines)
3. Remove HTTP/2 bridge (`h2-bridge.mjs`)
4. Use `cursor-agent --output-format stream-json` subprocess
5. Implement NDJSON stream parser
6. Simplify tool calling to stream event extraction

**Files to Remove:**
- `src/cursor/proto/agent_pb.ts` (15K lines of generated protobuf)
- `src/cursor/h2-bridge.mjs` (Node HTTP/2 bridge)
- `src/cursor/cursor-rpc.ts` (RPC utility for gRPC)

**Files to Rewrite:**
- `src/cursor/cursor-proxy-internal.ts` → New NDJSON-based proxy
- `src/cursor-provider.ts` → Simplify provider logic

**New File Structure:**
```
src/
  cursor/
    cursor-proxy-internal.ts  # Rewritten: NDJSON stream proxy
    cursor-client.ts          # New: SimpleCursorClient from opencode-cursor-1
    cursor-models.ts          # Simplified: no RPC, use hardcoded list
    streaming/
      parser.ts               # New: NDJSON line parser
      types.ts                # New: Stream event types
      line-buffer.ts          # New: Line buffering for chunks
```

---

### Phase 3: Provider Refactoring

**Goal**: Support both direct and proxy modes

**Changes:**
1. Add mode selection (`direct` vs `proxy`)
2. Direct mode: Spawn `cursor-agent` directly (no proxy)
3. Proxy mode: Use local HTTP proxy (existing pattern)
4. Implement tool call interception (optional, via callback)

**Files to Modify:**
- `src/cursor-provider.ts` - Add mode selection, direct mode support

**New File Structure:**
```
src/
  cursor-provider.ts     # Modified: support direct + proxy modes
  cursor/
    provider/
      boundary.ts        # New: Provider boundary abstraction (optional)
      tool-intercept.ts  # New: Tool call interception (optional)
```

---

### Phase 4: Streaming Utilities

**Goal**: Modular streaming infrastructure

**Changes:**
1. Create reusable streaming utilities
2. NDJSON parsing
3. Line buffering
4. SSE formatting for OpenAI compatibility
5. AI SDK parts conversion

**New Files:**
```
src/
  cursor/
    streaming/
      types.ts           # Stream event type definitions
      parser.ts          # NDJSON line parser
      line-buffer.ts     # Chunked line buffering
      openai-sse.ts      # SSE formatting
      delta-tracker.ts   # Text delta tracking
      ai-sdk-parts.ts    # AI SDK parts conversion
```

---

### Phase 5: Tool Calling Refactoring

**Goal**: Simplify tool calling via stream event extraction

**Changes:**
1. Remove MCP protobuf handling
2. Extract tool calls from NDJSON stream events
3. Support tool result injection for follow-up requests
4. Optional: Loop guard for infinite retry prevention

**Files to Modify:**
- `src/cursor/cursor-proxy-internal.ts` - Simplify tool handling

**New Files:**
```
src/
  cursor/
    tools/
      extractor.ts     # Tool call extraction from stream
      types.ts         # Tool event types
      loop-guard.ts    # Infinite loop prevention (optional)
```

---

## Implementation Order

1. **Phase 1: Auth** (Highest priority, foundational)
   - Rewrite `cursor-auth.ts`
   - Update `token-manager.ts`
   - Test auth flow end-to-end

2. **Phase 4: Streaming** (Enables proxy refactoring)
   - Create streaming utilities
   - Test NDJSON parsing
   - Test SSE formatting

3. **Phase 2: Proxy** (Core functionality)
   - Rewrite `cursor-proxy-internal.ts`
   - Remove protobuf/HTTP/2 dependencies
   - Test proxy with streaming

4. **Phase 3: Provider** (Integration layer)
   - Update `cursor-provider.ts`
   - Add mode selection
   - Test with AI SDK

5. **Phase 5: Tool Calling** (Advanced feature)
   - Implement tool extraction
   - Add loop guards (optional)
   - Test tool calling end-to-end

---

## Benefits of Refactoring

### Code Reduction
- Remove ~17K lines of protobuf/gRPC/HTTP/2 code
- Replace with ~2K lines of NDJSON/streaming code
- **Net reduction: ~15K lines (88% reduction)**

### Complexity Reduction
- No protobuf schema management
- No HTTP/2 bridge subprocess
- No conversation checkpoint management
- No active bridge lifecycle management

### Maintainability
- Simpler auth flow (delegate to cursor-agent)
- Easier to debug (JSON vs protobuf)
- Fewer dependencies (@bufbuild/protobuf can be removed)
- Better alignment with cursor's native tooling

### Performance
- Per-request spawning (no long-lived connections)
- Stateless proxy (no conversation state management)
- Lower memory footprint (no protobuf message caching)

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `cursor-agent` CLI changes | Medium | Monitor cursor releases, add version detection |
| Stream format changes | Low | NDJSON is stable, add schema validation |
| Tool calling differences | Medium | Test with common tools first (bash, read, write) |
| Performance regression | Low | Benchmark before/after, optimize hot paths |
| Breaking existing features | High | Comprehensive test suite, gradual rollout |

---

## Testing Strategy

### Unit Tests
- Auth flow (spawn, URL extraction, file polling)
- NDJSON parser (valid JSON, malformed lines, edge cases)
- Stream event extraction (text, thinking, tool_call)
- Tool call extraction (various tool types)

### Integration Tests
- End-to-end auth flow
- Proxy request/response cycle
- Streaming chat completions
- Tool calling with tool results

### Manual Testing
- Claude Code integration
- Various model types (Claude, GPT, Gemini, Grok)
- Tool calling scenarios (edit, bash, MCP tools)
- Long-running conversations

---

## Migration Path

### Backward Compatibility
- Keep existing PKCE auth as fallback (`CURSOR_AUTH_METHOD=pkce`)
- Support both old and new token storage paths
- Gradual migration: users can opt-in to new flow

### Feature Flags
- `CURSOR_AUTH_METHOD=pkce|agent` (default: agent)
- `CURSOR_PROXY_MODE=grpc|ndjson` (default: ndjson)
- `CURSOR_TOOL_MODE=mcp|stream` (default: stream)

### Deprecation Timeline
- Week 1-2: Implement new flow with feature flags
- Week 3-4: Default to new flow, keep old flow available
- Month 2: Deprecate old flow (warnings in logs)
- Month 3: Remove old flow (major version bump)

---

## Success Metrics

### Code Quality
- [ ] Remove 15K+ lines of protobuf/gRPC code
- [ ] Reduce cyclomatic complexity by 50%
- [ ] Achieve 80%+ test coverage

### Functionality
- [ ] All existing models work (Claude, GPT, Gemini, Grok)
- [ ] Tool calling works for common tools
- [ ] Streaming responses work correctly
- [ ] Auth flow is reliable (<1% failure rate)

### Performance
- [ ] Time-to-first-token < 500ms (same or better)
- [ ] Memory usage < 100MB (50% reduction)
- [ ] No memory leaks in long-running sessions

### User Experience
- [ ] Auth flow completes in <30 seconds
- [ ] No breaking changes for existing users
- [ ] Clear error messages for common issues

---

## Next Steps

1. **Review and approve this plan**
2. **Create implementation branch**
3. **Implement Phase 1 (Auth)**
4. **Test auth flow end-to-end**
5. **Proceed to Phase 2-5 iteratively**
6. **Comprehensive testing before merge**

---

## Reference Files from opencode-cursor-1

### Auth
- `src/auth.ts` - OAuth flow with `cursor-agent login`
- `src/commands/status.ts` - Auth status checking

### Proxy
- `src/proxy/server.ts` - Bun HTTP server
- `src/proxy/handler.ts` - Request parsing
- `src/proxy/prompt-builder.ts` - Prompt construction
- `src/proxy/tool-loop.ts` - Tool extraction
- `src/proxy/formatter.ts` - Response formatting

### Client
- `src/client/simple.ts` - SimpleCursorClient (stream-json)

### Streaming
- `src/streaming/types.ts` - Event type definitions
- `src/streaming/parser.ts` - NDJSON parsing
- `src/streaming/line-buffer.ts` - Line buffering
- `src/streaming/openai-sse.ts` - SSE formatting

### Provider
- `src/provider.ts` - AI SDK provider
- `src/provider/boundary.ts` - Provider boundary
- `src/provider/runtime-interception.ts` - Tool interception

### Tools
- `src/tools/registry.ts` - Tool registry
- `src/tools/router.ts` - Tool routing
- `src/tools/schema.ts` - Schema handling
