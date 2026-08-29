import { describe, expect, it } from "vitest";
import { decodeSource, encodeSource, readShare, shareHash } from "../src/services/share";

const SOURCE = ["fn work(n: int) -> int:", "  return (n * 2)", "", "print(work(21))"].join("\n");

describe("sharing a program in the URL", () => {
  it("round-trips a program through the hash", () => {
    expect(decodeSource(encodeSource(SOURCE))).toBe(SOURCE);
  });

  it("round-trips text that is not ASCII", () => {
    const vietnamese = 'print("chào bạn — 你好")';

    expect(decodeSource(encodeSource(vietnamese))).toBe(vietnamese);
  });

  it("encodes to something safe to put in a URL", () => {
    expect(encodeSource(SOURCE)).not.toMatch(/[+/=]/);
  });

  it("reads back the program, the target and the level it was shared with", () => {
    const hash = shareHash({ source: SOURCE, target: "c", optLevel: "max" });

    expect(readShare(hash)).toEqual({ source: SOURCE, target: "c", optLevel: "max" });
  });

  it("leaves out what the link does not carry", () => {
    const shared = readShare(shareHash({ source: SOURCE, target: null, optLevel: null }));

    expect(shared).toEqual({ source: SOURCE, target: null, optLevel: null });
  });

  it("ignores a level that is not one of ours", () => {
    expect(readShare(`#src=${encodeSource(SOURCE)}&opt=turbo`)!.optLevel).toBeNull();
  });

  it("reports nothing for an empty or unreadable hash", () => {
    expect(readShare("")).toBeNull();
    expect(readShare("#target=c")).toBeNull();
    expect(readShare("#src=!!!not base64!!!")).toBeNull();
  });
});
