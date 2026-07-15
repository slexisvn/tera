import { describe, it, expect } from 'vitest';
import { createConnection, BrowserMessageReader, BrowserMessageWriter } from 'vscode-languageserver/browser.js';
import { Duplex } from 'node:stream';
import * as rpc from 'vscode-jsonrpc/node.js';
import { startServer } from '../server/index.js';
import { legend as semanticLegend } from '../server/providers/semantic_tokens.js';

class Pipe extends Duplex {
  _read() {}
  _write(chunk, _enc, cb) { this.push(chunk); cb(); }
}

describe('LSP smoke', () => {
  it('returns completions including keywords', async () => {
    const clientToServer = new Pipe();
    const serverToClient = new Pipe();

    const serverReader = new rpc.StreamMessageReader(clientToServer);
    const serverWriter = new rpc.StreamMessageWriter(serverToClient);
    const serverConnection = (await import('vscode-languageserver/node.js')).createConnection(serverReader, serverWriter);
    await startServer(serverConnection);

    const clientReader = new rpc.StreamMessageReader(serverToClient);
    const clientWriter = new rpc.StreamMessageWriter(clientToServer);
    const client = rpc.createMessageConnection(clientReader, clientWriter);
    client.listen();

    await client.sendRequest('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
    await client.sendNotification('initialized', {});
    const uri = 'file:///t.tera';
    await client.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId: 'tera', version: 1, text: 'mod' },
    });
    const result = await client.sendRequest('textDocument/completion', {
      textDocument: { uri },
      position: { line: 0, character: 3 },
    });

    const items = Array.isArray(result) ? result : result?.items ?? [];
    const labels = items.map(i => i.label);
    expect(labels).toContain('model');
    expect(labels).toContain('Linear');
    const trainerItem = items.find(i => i.label === 'Trainer');
    expect(trainerItem?.insertText).toBe('Trainer($0)');
    const linearItem = items.find(i => i.label === 'Linear');
    expect(linearItem?.insertText).toMatch(/^Linear\(\$\{1:in\}, \$\{2:out\}\)\$0$/);

    const callUri = 'file:///c.tera';
    await client.sendNotification('textDocument/didOpen', {
      textDocument: { uri: callUri, languageId: 'tera', version: 1, text: 'x = Trainer()' },
    });
    const callResult = await client.sendRequest('textDocument/completion', {
      textDocument: { uri: callUri },
      position: { line: 0, character: 12 },
    });
    const callItems = Array.isArray(callResult) ? callResult : callResult?.items ?? [];
    const callLabels = callItems.map(i => i.label);
    expect(callLabels).toContain('max_epochs=');
    expect(callLabels).toContain('accelerator=');

    const memberUri = 'file:///m.tera';
    await client.sendNotification('textDocument/didOpen', {
      textDocument: { uri: memberUri, languageId: 'tera', version: 1, text: 'trainer = Trainer()\ntrainer.fit' },
    });
    const memberResult = await client.sendRequest('textDocument/completion', {
      textDocument: { uri: memberUri },
      position: { line: 1, character: 8 },
    });
    const memberItems = Array.isArray(memberResult) ? memberResult : memberResult?.items ?? [];
    const memberLabels = memberItems.map(i => i.label);
    expect(memberLabels).toContain('fit');
    expect(memberLabels).toContain('validate');
    expect(memberLabels).toContain('predict');

    const tensorUri = 'file:///t2.tera';
    await client.sendNotification('textDocument/didOpen', {
      textDocument: { uri: tensorUri, languageId: 'tera', version: 1, text: 'y = randn([2, 2])\ny.' },
    });
    const tensorResult = await client.sendRequest('textDocument/completion', {
      textDocument: { uri: tensorUri },
      position: { line: 1, character: 2 },
    });
    const tensorItems = Array.isArray(tensorResult) ? tensorResult : tensorResult?.items ?? [];
    const tensorLabels = tensorItems.map(i => i.label);
    expect(tensorLabels).toContain('reshape');
    expect(tensorLabels).toContain('shape');
    expect(tensorLabels).toContain('backward');
    expect(tensorLabels).toContain('relu');
    expect(tensorLabels).toContain('sum');

    const linearUri = 'file:///l.tera';
    await client.sendNotification('textDocument/didOpen', {
      textDocument: { uri: linearUri, languageId: 'tera', version: 1, text: 'fc = Linear(2, 3)\nfc.' },
    });
    const linearResult = await client.sendRequest('textDocument/completion', {
      textDocument: { uri: linearUri },
      position: { line: 1, character: 3 },
    });
    const linearItems = Array.isArray(linearResult) ? linearResult : linearResult?.items ?? [];
    const linearLabels = linearItems.map(i => i.label);
    expect(linearLabels).toContain('parameters');
    expect(linearLabels).toContain('forward');

    const adamUri = 'file:///a.tera';
    await client.sendNotification('textDocument/didOpen', {
      textDocument: { uri: adamUri, languageId: 'tera', version: 1, text: 'opt = Adam([])\nopt.' },
    });
    const adamResult = await client.sendRequest('textDocument/completion', {
      textDocument: { uri: adamUri },
      position: { line: 1, character: 4 },
    });
    const adamItems = Array.isArray(adamResult) ? adamResult : adamResult?.items ?? [];
    const adamLabels = adamItems.map(i => i.label);
    expect(adamLabels).toContain('step');
    expect(adamLabels).toContain('zero_grad');

    const modelUri = 'file:///model.tera';
    const modelText = 'model Net(c: int):\n  fc = Linear(2, c)\n  enc = LSTM(2, 2, 1, true)\n  forward (x: Tensor) -> Tensor:\n    return fc(x)\nfn run(net: Net) -> Tensor:\n  return net.fc';
    await client.sendNotification('textDocument/didOpen', {
      textDocument: { uri: modelUri, languageId: 'tera', version: 1, text: modelText },
    });
    const modelResult = await client.sendRequest('textDocument/completion', {
      textDocument: { uri: modelUri },
      position: { line: 6, character: 13 },
    });
    const modelItems = Array.isArray(modelResult) ? modelResult : modelResult?.items ?? [];
    const modelLabels = modelItems.map(i => i.label);
    expect(modelLabels).toContain('fc');
    expect(modelLabels).toContain('enc');

    const hoverResult = await client.sendRequest('textDocument/hover', {
      textDocument: { uri: memberUri },
      position: { line: 1, character: 9 },
    });
    const hoverValue = hoverResult?.contents?.value ?? '';
    expect(hoverValue).toContain('fit');
    expect(hoverValue.toLowerCase()).toContain('training loop');

    const chainUri = 'file:///chain.tera';
    const chainText = 'employees = dataframe()\nemployees.orderBy("salary").show()';
    await client.sendNotification('textDocument/didOpen', {
      textDocument: { uri: chainUri, languageId: 'tera', version: 1, text: chainText },
    });
    const chainHover = await client.sendRequest('textDocument/hover', {
      textDocument: { uri: chainUri },
      position: { line: 1, character: chainText.split('\n')[1].indexOf('show') + 1 },
    });
    const chainHoverValue = chainHover?.contents?.value ?? '';
    expect(chainHoverValue).toContain('show');
    expect(chainHoverValue).toContain('method of DataFrame');

    const chainTokens = await client.sendRequest('textDocument/semanticTokens/full', {
      textDocument: { uri: chainUri },
    });
    const methodIndex = semanticLegend.tokenTypes.indexOf('method');
    const data = chainTokens?.data ?? [];
    let methodCount = 0;
    for (let i = 0; i < data.length; i += 5) {
      if (data[i + 3] === methodIndex) methodCount++;
    }
    expect(methodCount).toBe(2);

    const paramUri = 'file:///param.tera';
    const paramText = 'noise = randn([2, 3], dtype=f32)';
    await client.sendNotification('textDocument/didOpen', {
      textDocument: { uri: paramUri, languageId: 'tera', version: 1, text: paramText },
    });
    const paramTokens = await client.sendRequest('textDocument/semanticTokens/full', {
      textDocument: { uri: paramUri },
    });
    const paramTypeAt = (targetLine, snippet) => {
      const col = paramText.split('\n')[targetLine].indexOf(snippet);
      const data2 = paramTokens?.data ?? [];
      let line = 0;
      let char = 0;
      for (let i = 0; i < data2.length; i += 5) {
        line += data2[i];
        char = data2[i] === 0 ? char + data2[i + 1] : data2[i + 1];
        if (line === targetLine && char === col) return semanticLegend.tokenTypes[data2[i + 3]];
      }
      return null;
    };
    expect(paramTypeAt(0, 'dtype=')).toBe('parameter');
    expect(paramTypeAt(0, 'randn(')).toBe('function');

    client.dispose();
  });
});
