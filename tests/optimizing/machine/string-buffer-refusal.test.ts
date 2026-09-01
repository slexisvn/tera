import { beforeEach, describe, expect, it } from "vitest";
import {
  irCallBuiltin,
  irConstant,
  irGenericAdd,
  resetIRNodeIds,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { X64Lowering } from "../../../src/optimizing/backends/x64/lowering.js";
import { RiscvLowering } from "../../../src/optimizing/backends/riscv64/lowering.js";
import { isBackendLoweringError } from "../../../src/optimizing/target/errors.js";
import { qualifiedMethodName } from "../../../src/optimizing/metadata/builtin-methods.js";
import type { SelectionContext } from "../../../src/optimizing/machine/lowering.js";

beforeEach(() => resetIRNodeIds());

type BufferRequester = { requireStringBuffer(ctx: SelectionContext): unknown };

const bufferlessContext = (node: CFGInstruction): SelectionContext =>
  ({ node, legality: { stringBufferOf: () => null } }) as unknown as SelectionContext;

const lowerings: ReadonlyArray<[string, () => BufferRequester]> = [
  ["x64", () => new X64Lowering() as unknown as BufferRequester],
  ["riscv64", () => new RiscvLowering() as unknown as BufferRequester],
];

describe("a string producer with no buffer is refused, not dereferenced", () => {
  for (const [name, make] of lowerings) {
    it(`${name} names the concatenation it cannot place`, () => {
      const node = irGenericAdd(irConstant("a"), irConstant("b"));

      let thrown: unknown = null;
      try {
        make().requireStringBuffer(bufferlessContext(node));
      } catch (error) {
        thrown = error;
      }

      expect(isBackendLoweringError(thrown)).toBe(true);
      expect((thrown as Error).message).toContain("string concatenation");
      expect((thrown as Error).message).toContain("keep this part interpreted");
    });

    it(`${name} names the builtin it cannot place`, () => {
      const builtin = qualifiedMethodName("int", "to_string");
      const node = irCallBuiltin(builtin, [irConstant(1)]);

      let thrown: unknown = null;
      try {
        make().requireStringBuffer(bufferlessContext(node));
      } catch (error) {
        thrown = error;
      }

      expect(isBackendLoweringError(thrown)).toBe(true);
      expect((thrown as Error).message).toContain(builtin);
    });
  }
});
