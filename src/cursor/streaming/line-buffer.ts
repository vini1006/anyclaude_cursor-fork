/**
 * Line buffer for chunked stream processing
 * Handles incomplete lines from chunked reads
 */

export class LineBuffer {
  private buffer: string = "";

  /**
   * Push a chunk of data to the buffer and return complete lines
   */
  push(chunk: Buffer | string): string[] {
    const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.buffer += data;

    const lines = this.buffer.split("\n");
    // Keep the last (potentially incomplete) line in the buffer
    this.buffer = lines.pop() || "";

    return lines.filter((line) => line.length > 0);
  }

  /**
   * Flush any remaining content in the buffer
   * Call this when the stream ends
   */
  flush(): string[] {
    if (this.buffer.length === 0) {
      return [];
    }

    const remaining = this.buffer;
    this.buffer = "";
    return [remaining];
  }

  /**
   * Clear the buffer
   */
  clear(): void {
    this.buffer = "";
  }

  /**
   * Get the current buffer content without clearing
   */
  peek(): string {
    return this.buffer;
  }
}
