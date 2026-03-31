# Fix: Cursor "Blob not found" intermittent error

## Context

Cursor proxy (`src/cursor/cursor-proxy-internal.ts`)에서 간헐적으로 "Blob not found" 에러 발생. Cursor 서버가 KV `getBlobArgs` 메시지로 blob을 요청할 때, 로컬 `blobStore`에서 해당 blob을 찾지 못하면 빈 `GetBlobResult`를 반환하여 Cursor 측에서 에러 발생.

## Root Cause Analysis

### 원인 1: Bridge 사망 시 blob 유실 (주요 원인)

1. `buildCursorRequest` (line 686)에서 `stored.blobStore`의 **복사본** 생성
2. Streaming 중 Cursor 서버가 `setBlobArgs`로 blob 저장 → 복사본에만 존재
3. Tool call 발생 시 `activeBridges`에 복사본 저장 (line 1404-1410)
4. Bridge가 죽으면 `onClose` (line 1441)에서 blob sync → `stored.blobStore`로 복사
5. **BUT**: `onMcpExec` 시점에는 sync가 없음 → bridge가 죽기 전에 sync가 안 된 상태에서 다음 요청이 올 수 있음

### 원인 2: Conversation 상태 조기 eviction

- `evictStaleConversations()` (line 167)가 매 요청마다 실행 (line 531)
- Active bridge가 있는 conversation도 TTL(30분) 지나면 evict
- Tool 실행이 오래 걸리면 conversation state (blobStore 포함) 삭제 가능

### 원인 3: 진단 부재

- Blob lookup 실패 시 로깅 없음 → 원인 파악 불가

## Implementation Plan

### 파일: `src/cursor/cursor-proxy-internal.ts`

### 1. mcpExec 발생 시 즉시 blob sync 추가 (핵심 수정)

`createBridgeStreamResponse` 내 `onMcpExec` 콜백 (line ~1376-1410)에서, `activeBridges.set()` 전에 blob을 `stored.blobStore`에 즉시 sync:

```typescript
// line ~1402, activeBridges.set() 직전에 추가
const stored = conversationStates.get(convKey);
if (stored) {
  for (const [k, v] of blobStore) stored.blobStore.set(k, v);
  stored.lastAccessMs = Date.now();
}
```

→ Bridge가 죽어도 blob이 이미 conversationStates에 보존됨

### 2. ActiveBridge에 convKey 추가 + eviction guard

`ActiveBridge` interface (line 144)에 `convKey` 필드 추가:

```typescript
interface ActiveBridge {
  bridge: ReturnType<typeof spawnBridge>;
  heartbeatTimer: NodeJS.Timeout;
  blobStore: Map<string, Uint8Array>;
  mcpTools: McpToolDefinition[];
  pendingExecs: PendingExec[];
  convKey: string; // 추가
}
```

`activeBridges.set()` (line 1404)에 `convKey` 포함.

`evictStaleConversations()` (line 167)에서 active bridge가 있는 conversation은 evict하지 않도록 수정:

```typescript
function evictStaleConversations(): void {
  const now = Date.now();
  const activeConvKeys = new Set(
    [...activeBridges.values()].map((b) => b.convKey)
  );
  for (const [key, stored] of conversationStates) {
    if (
      now - stored.lastAccessMs > CONVERSATION_TTL_MS &&
      !activeConvKeys.has(key)
    ) {
      conversationStates.delete(key);
    }
  }
}
```

### 3. Debug 로깅 추가

`handleKvMessage` (line 1008)에서 blob miss 시 로깅:

```typescript
// getBlobArgs 처리 내 (line 1018 이후)
if (!blobData) {
  debug(
    1,
    `Blob not found: key=${blobIdKey.slice(0, 16)}... (store size=${blobStore.size})`
  );
}
```

`handleChatCompletion`에서 bridge 없이 tool result 도착 시 로깅 (line 491 이후):

```typescript
if (!activeBridge && toolResults.length > 0) {
  debug(
    1,
    `No active bridge for tool result resume (bridgeKey=${bridgeKey.slice(0, 8)}..., ${activeBridges.size} bridges active)`
  );
}
```

## Verification

1. `bun run build` 성공 확인
2. `ANYCLAUDE_DEBUG=1 PROXY_ONLY=true bun run src/main.ts` 로 프록시 실행
3. Cursor에서 tool call이 포함된 요청 반복 테스트
4. Blob not found 로그가 더 이상 발생하지 않는지 확인
