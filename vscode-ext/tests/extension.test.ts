import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { activate, deactivate } from "../src/client/extension.ts";
import { calls, resetCalls } from "./stubs/vscode.ts";
import { resetClients, started, stopped } from "./stubs/vscode-languageclient.ts";

const EXT_ROOT = join(import.meta.dirname, "..");

function fakeContext() {
  const subscriptions: Array<{ dispose(): void }> = [];
  return {
    subscriptions,
    asAbsolutePath: (relative: string) => join(EXT_ROOT, relative),
  } as never;
}

describe("extension activation", () => {
  beforeEach(() => {
    resetCalls();
    resetClients();
  });

  it("registers the notebook controller and serializer", async () => {
    await activate(fakeContext());
    expect(calls.notebookControllers).toEqual(["tera-kernel"]);
    expect(calls.serializers).toEqual(["tera-notebook"]);
  });

  it("starts the language client against the bundled server", async () => {
    await activate(fakeContext());
    expect(started).toHaveLength(1);
    expect(started[0].name).toBe("Tera Language Server");

    const options = started[0].options as { run: { module: string; transport: number } };
    expect(options.run.module.endsWith(join("dist", "server.mjs"))).toBe(true);
    expect(options.run.transport).toBe(1);
  });

  it("surfaces a start failure instead of throwing out of activate", async () => {
    const { LanguageClient } = await import("./stubs/vscode-languageclient.ts");
    const start = LanguageClient.prototype.start;
    LanguageClient.prototype.start = async () => {
      throw new Error("boom");
    };

    try {
      await expect(activate(fakeContext())).resolves.toBeUndefined();
      expect(calls.errors[0]).toContain("boom");
    } finally {
      LanguageClient.prototype.start = start;
    }
  });

  it("stops the client on deactivate", async () => {
    await activate(fakeContext());
    await deactivate();
    expect(stopped).toEqual(["tera"]);
  });
});
