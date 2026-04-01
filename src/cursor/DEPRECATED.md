/**
 * @deprecated This file is deprecated and will be removed in a future version.
 * 
 * The old gRPC/protobuf-based proxy has been replaced with a simpler
 * NDJSON stream-based implementation.
 * 
 * New implementation: src/cursor/proxy/server.ts
 * New client: src/cursor/cursor-client.ts
 * 
 * @packageDocumentation
 */

// This file is kept for backward compatibility but is no longer used
// by the default implementation. To use the new implementation, import
// from src/cursor/proxy/server.ts instead.

export { startCursorProxyInternal, stopCursorProxyInternal } from "./cursor-proxy-internal";
