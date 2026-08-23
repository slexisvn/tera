import { describe, expect, it } from "vitest";
import { AOT_OPCODES } from "../../../src/optimizing/analyses/aot-legality.js";
import { createBackendRegistry } from "../../../src/optimizing/backends/index.js";
import { isAotBackend } from "../../../src/optimizing/target/backend.js";

function aotBackends() {
  return [...createBackendRegistry().list()].filter(isAotBackend);
}

describe("backend opcode coverage", () => {
  it("admits nothing a backend cannot emit", () => {
    const drifted: Array<readonly [string, readonly string[]]> = [];
    for (const backend of aotBackends()) {
      const missing = [...AOT_OPCODES].filter((opcode) => !backend.emits.has(opcode)).sort();
      if (missing.length > 0) drifted.push([backend.id, missing]);
    }

    expect(drifted).toEqual([]);
  });

  it("gives every AOT backend a coverage set that carries the shared opcodes", () => {
    for (const backend of aotBackends()) {
      expect([backend.id, backend.emits.size > 0]).toEqual([backend.id, true]);
    }
  });
});
