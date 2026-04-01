import type { StreamJsonEvent } from "./types.js";

/**
 * Parse a single line of NDJSON from cursor-agent stream
 * Returns null for invalid or empty lines
 */
export function parseStreamJsonLine(line: string): StreamJsonEvent | null {
  if (!line || line.trim().length === 0) {
    return null;
  }

  try {
    const data = JSON.parse(line);
    
    // Validate that it has a type field
    if (!data || typeof data.type !== "string") {
      return null;
    }

    return data as StreamJsonEvent;
  } catch (error) {
    // Invalid JSON, return null
    return null;
  }
}

/**
 * Parse multiple lines of NDJSON
 * Returns array of valid events, skipping invalid lines
 */
export function parseStreamJsonLines(lines: string[]): StreamJsonEvent[] {
  const events: StreamJsonEvent[] = [];
  
  for (const line of lines) {
    const event = parseStreamJsonLine(line);
    if (event) {
      events.push(event);
    }
  }
  
  return events;
}

/**
 * Validate a stream event has required fields for its type
 */
export function validateStreamEvent(event: StreamJsonEvent): boolean {
  if (!event.type) {
    return false;
  }

  // Type-specific validation
  switch (event.type) {
    case "assistant":
      return typeof (event as any).text === "string";
    case "thinking":
      return typeof (event as any).text === "string";
    case "tool_call":
      return typeof (event as any).name === "string" && 
             typeof (event as any).input === "object";
    case "tool_result":
      return typeof (event as any).call_id === "string" &&
             typeof (event as any).name === "string" &&
             typeof (event as any).output === "string";
    case "error":
      return typeof (event as any).error === "string";
    default:
      return true;
  }
}
