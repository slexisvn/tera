import { readSync } from "node:fs";

const CHUNK_BYTES = 4096;
const STDIN_FD = 0;
const END_OF_INPUT_CODES = new Set(["EOF", "ENXIO", "EBADF", "EIO"]);

export type ChunkReader = (into: Buffer) => number;
export type StdinSuspension = { suspend(): void; resume(): void };

export function createLineReader(readChunk: ChunkReader): () => string | null {
  let pending = "";
  let exhausted = false;
  const buffer = Buffer.alloc(CHUNK_BYTES);

  return () => {
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        return line.endsWith("\r") ? line.slice(0, -1) : line;
      }
      if (exhausted) {
        if (pending.length === 0) return null;
        const rest = pending;
        pending = "";
        return rest;
      }
      const read = readChunk(buffer);
      if (read <= 0) exhausted = true;
      else pending += buffer.toString("utf8", 0, read);
    }
  };
}

function readStdinChunk(into: Buffer): number {
  for (;;) {
    try {
      return readSync(STDIN_FD, into, 0, into.length, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") continue;
      if (code !== undefined && END_OF_INPUT_CODES.has(code)) return 0;
      throw error;
    }
  }
}

function suspendedChunkReader(suspension: StdinSuspension): ChunkReader {
  return (into) => {
    suspension.suspend();
    try {
      return readStdinChunk(into);
    } finally {
      suspension.resume();
    }
  };
}

export function createStdinInput(suspension?: StdinSuspension): (prompt: string) => string | null {
  const readLine = createLineReader(suspension ? suspendedChunkReader(suspension) : readStdinChunk);
  return (prompt) => {
    if (prompt.length > 0) process.stdout.write(prompt);
    return readLine();
  };
}
