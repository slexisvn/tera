import { describe, it } from "vitest";
import { differential, src } from "../../helpers/tiers.js";

const HOLDER = [
  "class Holder:",
  "  public constructor(n: int):",
  "    this.n = n",
  "  public self() -> Holder:",
  "    return this",
  "  public value() -> int:",
  "    return this.n",
];

const CURSOR = [
  "class Cursor:",
  "  public constructor(start: int, stop: int):",
  "    this.at = start",
  "    this.stop = stop",
  '    this["@@iterator"] = () => this',
  "  public next() -> { done: bool, value: int | null }:",
  "    if this.at >= this.stop:",
  "      return { done: true, value: null }",
  "    held = this.at",
  "    this.at += 1",
  "    return { done: false, value: held }",
];

describe("a method that hands back its receiver, across the tiers", () => {
  it("answers the receiver it was called on, past the tier-up", () => {
    differential(
      src(
        ...HOLDER,
        "fn run(rounds: int) -> int:",
        "  wrong: int = 0",
        "  at: int = 0",
        "  while at < rounds:",
        "    held = Holder(at)",
        "    if held.self().n != at:",
        "      wrong = wrong + 1",
        "    at = at + 1",
        "  return wrong",
        "run(120)",
      ),
    );
  });

  it("answers the same receiver every time when there is only one", () => {
    differential(
      src(
        ...HOLDER,
        "fn run(rounds: int) -> int:",
        "  held = Holder(7)",
        "  wrong: int = 0",
        "  at: int = 0",
        "  while at < rounds:",
        "    if held.self().n != 7:",
        "      wrong = wrong + 1",
        "    at = at + 1",
        "  return wrong",
        "run(120)",
      ),
    );
  });

  it("keeps reading a field through the receiver working", () => {
    differential(
      src(
        ...HOLDER,
        "fn run(rounds: int) -> int:",
        "  wrong: int = 0",
        "  at: int = 0",
        "  while at < rounds:",
        "    held = Holder(at)",
        "    if held.value() != at:",
        "      wrong = wrong + 1",
        "    at = at + 1",
        "  return wrong",
        "run(120)",
      ),
    );
  });

  it("walks a class whose iterator hook hands back the receiver", () => {
    differential(
      src(
        ...CURSOR,
        "fn run(rounds: int) -> int:",
        "  full: int = 0",
        "  at: int = 0",
        "  while at < rounds:",
        "    saw: int = 0",
        "    for held of Cursor(0, 3):",
        "      saw = saw + 1",
        "    if saw == 3:",
        "      full = full + 1",
        "    at = at + 1",
        "  return full",
        "run(120)",
      ),
    );
  });
});
