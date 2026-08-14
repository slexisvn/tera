import { describe, expect, it } from "vitest";
import { TeraDebugAdapter } from "../src/client/debug/adapter.ts";
import type { ProtocolMessage, ResponseMessage } from "../src/client/debug/protocol.ts";

function collect(adapter: TeraDebugAdapter): ProtocolMessage[] {
  const messages: ProtocolMessage[] = [];
  adapter.onDidSendMessage((message) => messages.push(message));
  return messages;
}

describe("Tera debug adapter", () => {
  it("evaluates watches from locals and globals", () => {
    const adapter = new TeraDebugAdapter("debug-worker.mjs");
    const messages = collect(adapter);
    (adapter as unknown as {
      currentPause: unknown;
    }).currentPause = {
      snapshot: {
        callStack: ["<script>"],
        frames: [{
          functionName: "<script>",
          functionId: 1,
          pc: 0,
          location: null,
          accumulator: { tag: "undefined", display: "undefined" },
          locals: [{
            name: "localOnly",
            slot: 0,
            kind: "let",
            value: { tag: "number", display: "3" },
          }, {
            name: "_iter$",
            slot: 1,
            kind: "temp",
            internal: true,
            value: { tag: "undefined", display: "undefined" },
          }],
        }],
        globals: [{
          name: "add10",
          slot: 0,
          kind: "global",
          value: { tag: "function", display: "[Function: add]" },
        }, {
          name: "nums",
          slot: 1,
          kind: "global",
          value: {
            tag: "array",
            display: "[1, 2, 3]",
            children: [
              { name: "length", value: { tag: "smi", display: "3", raw: 3 } },
              { name: "0", value: { tag: "smi", display: "1", raw: 1 } },
              { name: "1", value: { tag: "smi", display: "2", raw: 2 } },
              { name: "2", value: { tag: "smi", display: "3", raw: 3 } },
            ],
          },
        }],
      },
    };

    adapter.handleMessage({
      seq: 1,
      type: "request",
      command: "evaluate",
      arguments: { expression: "add10", frameId: 1000 },
    });
    adapter.handleMessage({
      seq: 2,
      type: "request",
      command: "evaluate",
      arguments: { expression: "localOnly", frameId: 1000 },
    });
    adapter.handleMessage({
      seq: 3,
      type: "request",
      command: "evaluate",
      arguments: { expression: "nums.length + nums[1]", frameId: 1000 },
    });
    adapter.handleMessage({
      seq: 4,
      type: "request",
      command: "variables",
      arguments: { variablesReference: 1000 },
    });

    const responses = messages.filter((message): message is ResponseMessage =>
      message.type === "response",
    );
    expect(responses[0]!.body).toMatchObject({
      result: "[Function: add]",
      type: "function",
    });
    expect(responses[1]!.body).toMatchObject({
      result: "3",
      type: "number",
    });
    expect(responses[2]!.body).toMatchObject({
      result: "5",
      type: "smi",
    });
    expect(responses[3]!.body).toMatchObject({
      variables: [
        expect.objectContaining({ name: "localOnly" }),
      ],
    });
    expect(JSON.stringify(responses[3]!.body)).not.toContain("_iter$");
  });
});
