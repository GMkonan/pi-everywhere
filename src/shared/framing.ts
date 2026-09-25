export class JsonLineDecoder {
  private buffer = "";

  constructor(private readonly maxBufferedBytes = 2 * 1024 * 1024) {}

  push(chunk: Buffer | string): unknown[] {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxBufferedBytes) {
      this.buffer = "";
      throw new Error("NDJSON buffer exceeded the configured limit");
    }

    const messages: unknown[] = [];
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;

      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      messages.push(JSON.parse(line));
    }
    return messages;
  }
}

export function encodeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
