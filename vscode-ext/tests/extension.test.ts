import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { activate, deactivate } from "../src/client/extension.ts";
import { calls, resetCalls, window } from "./stubs/vscode.ts";
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

  it("registers the Tera debug adapter used by F5", async () => {
    await activate(fakeContext());
    expect(calls.debugConfigurationProviders).toEqual(["tera"]);
    expect(calls.debugAdapterFactories).toEqual(["tera"]);
  });

  it("resolves F5 debug config from the active Tera file", async () => {
    const file = join(EXT_ROOT, "sample.tera");
    window.activeTextEditor = {
      document: { languageId: "tera", uri: { fsPath: file } },
    };
    await activate(fakeContext());

    const provider = calls.debugConfigurationProviderInstances[0] as {
      resolveDebugConfiguration(folder: unknown, config: Record<string, unknown>): Record<string, unknown> | undefined;
    };
    const config = provider.resolveDebugConfiguration(undefined, {
      type: "tera",
      request: "launch",
      name: "Debug Tera File",
      program: "${file}",
    });

    expect(config?.program).toBe(file);
    expect(config?.cwd).toBe(EXT_ROOT);
    expect(config).not.toHaveProperty("stopOnEntry");
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
