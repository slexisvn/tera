import { describe, expect, it } from "vitest";
import {
  contextAddress,
  contextField,
  contextWidthOf,
} from "../../../../src/optimizing/backends/riscv64/context.js";
import { use } from "../../../../src/optimizing/machine/ir.js";
import { riscvTarget } from "../../../../src/optimizing/backends/riscv64/target.js";
import {
  TERA_CONTEXT,
  TERA_POINTER_BYTES,
} from "../../../../src/optimizing/target/runtime-layout.js";

const base = use(riscvTarget().registers.register("t0"), TERA_POINTER_BYTES);

describe("riscv64 context addressing", () => {
  it("names the one symbol the whole backend reaches the context through", () => {
    expect(contextAddress()).toEqual({ kind: "symbol", name: TERA_CONTEXT.symbol });
  });

  it("addresses a field at the offset the shared layout declares", () => {
    const field = contextField(base, "arenaCursor");

    expect(field).toMatchObject({
      kind: "memory",
      address: { base, displacement: TERA_CONTEXT.offsetOf("arenaCursor") },
    });
  });

  it("carries the declared width so the caller can pick the load", () => {
    expect(contextWidthOf("arenaCursor")).toBe(TERA_CONTEXT.field("arenaCursor").bytes);
    expect(contextWidthOf("pendingThrowFlag")).toBe(
      TERA_CONTEXT.field("pendingThrowFlag").bytes,
    );
  });

  it("gives the pending-throw flag a narrower slot than a pointer field", () => {
    expect(contextWidthOf("pendingThrowFlag")).toBeLessThan(contextWidthOf("arenaBase"));
  });
});
