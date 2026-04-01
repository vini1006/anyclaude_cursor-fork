# Handoff: cursor/composer-2 tool calling 디버그 진행 상황

## 현재 브랜치 상태

`src/cursor/cursor-proxy-internal.ts` 에 uncommitted 변경 있음 (`git diff`로 확인).

---

## 원래 플랜 fix 구현 상태 (모두 완료됨)

`docs/claude/plans/cursor-composr2-tool-calling-fix.md` 에 기술된 6개 fix는 모두 working tree에 구현되어 있음:

1. `OpenAIMessage.is_error` 필드 추가 (line ~107)
2. `ToolResultInfo.isError` 필드 추가
3. `ConversationTurn` 인터페이스 + `hasToolCalls` 필드
4. `textContent`: `p.text != null` (이전: `p.text`)
5. `parseMessages` 전면 재작성: trailing tool results / history turns 분리
6. `buildCursorRequest`: `hasToolCalls` 턴도 step으로 포함
7. `handleToolResultResume`: `isError` → `McpError` 매핑

이 부분은 **건드리지 말 것**.

---

## 실제로 재현되는 버그 (새로 발견)

### 증상

```
clc --model cursor/composer-2
> /init
● Reading the repository...
  Searched for 4 patterns, read 1 file
  └ Invalid tool parameters    ← 여기서 실패
```

### 디버그 로그에서 확인한 패턴 (실패 케이스)

```
Storing bridge (tool=Read, pendingExecs=1)
Storing bridge (tool=Read, pendingExecs=2)
Storing bridge (tool=Read, pendingExecs=3)
Storing bridge (tool=Glob, pendingExecs=4)
Storing bridge (tool=Glob, pendingExecs=5)
                                            ← Resuming 없음!
Storing bridge (tool=Read, pendingExecs=1)  ← 새 사이클
Resuming bridge (alive=true, toolResults=1)
...
No active bridge for tool result resume (bridgeKey=9b3916b2..., 0 bridges active)
Blob not found: key=...
[Error: Connect error internal: Blob not found]
```

### 성공 케이스 패턴

```
Storing bridge (tool=Read, pendingExecs=1)
Resuming bridge (alive=true, toolResults=1)
Storing bridge (tool=Read, pendingExecs=1)
Resuming bridge (alive=true, toolResults=1)
...  (항상 pendingExecs=1씩 처리)
```

### 근본 원인 (확인됨)

Cursor가 한 번에 여러 `mcpArgs`를 연속 패킷으로 보낼 때 발생.

`onMcpExec` 콜백 구조:
```
onMcpExec(exec) {
  state.pendingExecs.push(exec)       // exec 1 → pendingExecs=[1]
  sendSSE(tool_call chunk)            // SSE에 tool_call 1 전송
  activeBridges.set(bridgeKey, ...)   // bridge 저장
  sendSSE(finish_reason: tool_calls)
  sendDone()
  closeController()                   // ← stream 닫힘!
  // exec 2가 오면: sendSSE는 closed=true라 무시됨
  // 하지만 state.pendingExecs=[1,2], activeBridges.set 다시 호출됨
}
```

문제: **첫 번째 exec에서 SSE stream이 닫히면** 두 번째 이후 exec의 tool_call 청크가 Claude Code에 전달되지 않음. Claude Code는 tool_call_id 1개만 알고 result도 1개만 보내지만, `pendingExecs`에는 5개가 쌓여 있음.

다음 resume 요청에서 `handleToolResultResume`은 5개 exec에 대해 result를 찾는데:
- 1개만 매칭 → 나머지 4개에 "Tool result not provided" error 전송
- Cursor가 이 error들에 반응해 실패하거나, 아니면 별도 경로로 실패

**왜 "0 bridges active"인가**: `pendingExecs=5` 사이클의 경우, Cursor가 mcpArgs 5개를 보낸 후 bridge process를 즉시 닫는 것으로 보임 (code=0). 이때 debounce timer(20ms)가 아직 실행 전이라 `activeBridges.set`이 안 된 상태.

### 시도한 수정들 (현재 working tree에 있음)

1. **`queueMicrotask` defer** → 실패. 각 exec가 별도 I/O 이벤트(별도 패킷)라 microtask는 첫 exec 직후 실행됨.

2. **20ms debounce (`setTimeout`)** → 실패. bridge process가 20ms 안에 닫힘.

3. **`onClose`에서 pending timer 즉시 실행** → 아직 검증 안 됨 (마지막 실행 시 interrupted).

현재 working tree의 코드는 2 + 3이 모두 적용된 상태.

---

## 다음에 해야 할 것

### 검증 먼저

```bash
ANYCLAUDE_DEBUG=2 bun run --bun src/main.ts --dangerously-skip-permissions \
  --model cursor/composer-2 --print "/init" 2>&1 \
  | grep -E "(No active bridge|Blob not found|Connect error)"
```

에러가 없으면 현재 코드(debounce + onClose flush)가 동작하는 것.

### 만약 여전히 실패하면

가설: `onClose`가 `code=0`으로 와도 bridge는 `activeBridges`에 있음 (`debounce → onClose → flush` 순서라면). 하지만 그 bridge의 h2-bridge 프로세스는 이미 죽어있음. 다음 resume 요청에서 `activeBridge.bridge.alive`가 false → fallthrough → 새 bridge 시작 시 Blob not found.

**근본적 해결 방향**: `onClose` 이전에 모든 exec 수집이 완료되도록 해야 함. 두 가지 옵션:

**옵션 A**: Cursor가 mcpArgs를 전송 완료한 후 보내는 신호를 찾아서 그때 stream 닫기. 프로토콜 분석 필요.

**옵션 B**: bridge가 죽은 경우에도 checkpoint로 resume이 가능하도록 `handleChatCompletion` fallthrough 경로를 고치기. 현재 fallthrough에서 `Blob not found`가 나는 이유:
- `storedForSync`의 blobStore에 특정 key가 없음 (`store size=60`인데 3개 key가 없음)
- `onClose` 시 blob sync가 완전하지 않거나, checkpoint 자체가 그 blob들을 참조함

**옵션 C** (가장 단순): `pendingExecs`가 생긴 즉시 bridge가 닫히는 시나리오에서, 모든 exec를 SSE로 보내기 전에 bridge가 닫히는 것을 막기. `mcpArgs` 도착 즉시 Cursor에 acknowledgement를 보내서 bridge를 살아있게 유지.

---

## 핵심 파일

- `src/cursor/cursor-proxy-internal.ts`
  - `onMcpExec` 콜백: line ~1432
  - `bridge.onClose`: line ~1522
  - `handleToolResultResume`: line ~1629
  - `createConnectFrameParser`: line 881 (여러 프레임을 한 while 루프에서 처리)

---

## 재현 조건

- `clc --model cursor/composer-2` + `/init`
- Non-deterministic: 때로 성공, 때로 실패
- Cursor가 동시에 여러 tool call을 보낼 때만 실패 (pendingExecs > 1)
- bridgeKey는 항상 `9b3916b2` (이 repo에서 /init 실행 시)
