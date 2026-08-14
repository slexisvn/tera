import { describe, expect, it } from "vitest";
import { sequenceParallelCopies } from "../../../src/optimizing/machine/parallel-copy.js";

interface Move {
  readonly destination: string;
  readonly source: string;
}

function sequence(copies: readonly Move[]): Move[] {
  const emitted: Move[] = [];
  let temps = 0;
  sequenceParallelCopies(
    copies,
    (destination, source) => emitted.push({ destination, source }),
    () => `t${temps++}`,
  );
  return emitted;
}

function simulate(copies: readonly Move[], start: Record<string, number>): Record<string, number> {
  const state: Record<string, number> = { ...start };
  for (const move of sequence(copies)) state[move.destination] = state[move.source]!;
  return state;
}

describe("sequenceParallelCopies", () => {
  it("drops copies whose destination is its own source", () => {
    expect(sequence([{ destination: "a", source: "a" }])).toEqual([]);
  });

  it("orders a chain so no source is clobbered before it is read", () => {
    const state = simulate(
      [
        { destination: "a", source: "b" },
        { destination: "b", source: "c" },
      ],
      { a: 1, b: 2, c: 3 },
    );

    expect(state).toMatchObject({ a: 2, b: 3, c: 3 });
  });

  it("breaks a two-register swap with a temporary", () => {
    const copies: Move[] = [
      { destination: "a", source: "b" },
      { destination: "b", source: "a" },
    ];

    expect(sequence(copies)).toHaveLength(3);
    expect(simulate(copies, { a: 1, b: 2 })).toMatchObject({ a: 2, b: 1 });
  });

  it("breaks a three-register rotation", () => {
    const copies: Move[] = [
      { destination: "a", source: "b" },
      { destination: "b", source: "c" },
      { destination: "c", source: "a" },
    ];

    expect(simulate(copies, { a: 1, b: 2, c: 3 })).toMatchObject({ a: 2, b: 3, c: 1 });
  });

  it("fans one source out to several destinations", () => {
    const copies: Move[] = [
      { destination: "a", source: "c" },
      { destination: "b", source: "c" },
      { destination: "c", source: "a" },
    ];

    expect(simulate(copies, { a: 1, b: 2, c: 3 })).toMatchObject({ a: 3, b: 3, c: 1 });
  });

  it("keeps a cycle that also has an entering chain correct", () => {
    const copies: Move[] = [
      { destination: "a", source: "b" },
      { destination: "b", source: "a" },
      { destination: "d", source: "a" },
    ];

    expect(simulate(copies, { a: 1, b: 2, d: 9 })).toMatchObject({ a: 2, b: 1, d: 1 });
  });
});
