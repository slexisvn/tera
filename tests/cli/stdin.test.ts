import { describe, expect, it } from "vitest";
import { createLineReader } from "../../src/cli/stdin.js";

const chunkReader = (chunks: string[]) => {
  let index = 0;
  return (into: Buffer) => {
    if (index >= chunks.length) return 0;
    return into.write(chunks[index++]!, 0, "utf8");
  };
};

const drain = (chunks: string[], count: number) => {
  const readLine = createLineReader(chunkReader(chunks));
  return Array.from({ length: count }, () => readLine());
};

describe("createLineReader", () => {
  it("strips a trailing carriage return from CRLF lines", () => {
    expect(drain(["first\r\nsecond\r\n"], 3)).toEqual(["first", "second", null]);
  });

  it("returns a final line that has no terminator", () => {
    expect(drain(["complete\nno newline here"], 3)).toEqual(["complete", "no newline here", null]);
  });

  it("splits several lines arriving in one chunk", () => {
    expect(drain(["a\nb\nc\n"], 4)).toEqual(["a", "b", "c", null]);
  });

  it("joins one line split across chunks", () => {
    expect(drain(["par", "tial line", " end\n"], 2)).toEqual(["partial line end", null]);
  });

  it("preserves empty lines", () => {
    expect(drain(["\n\nx\n"], 4)).toEqual(["", "", "x", null]);
  });

  it("keeps returning null once the input is exhausted", () => {
    expect(drain(["only\n"], 3)).toEqual(["only", null, null]);
  });

  it("does not read another chunk while buffered lines remain", () => {
    let reads = 0;
    const readLine = createLineReader((into) => {
      reads++;
      return reads === 1 ? into.write("one\ntwo\n", 0, "utf8") : 0;
    });
    expect(readLine()).toBe("one");
    expect(readLine()).toBe("two");
    expect(reads).toBe(1);
  });
});
