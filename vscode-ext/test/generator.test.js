import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from '../scripts/generate.js';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '../..');

describe('generate()', () => {
  it('produces deterministic outputs from canonical sources', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tera-gen-'));
    const outputs = {
      grammar: join(tmp, 'grammar.json'),
      languageData: join(tmp, 'language-data.json'),
      snippets: join(tmp, 'snippets.json'),
    };
    const sources = {
      parser: join(REPO_ROOT, 'src/cli/parser.js'),
      tokenizer: join(REPO_ROOT, 'src/cli/tokenizer.js'),
      builtins: join(REPO_ROOT, 'src/cli/builtins.js'),
      builtinDocs: join(REPO_ROOT, 'vscode-ext/data/builtin-docs.md'),
    };
    const first = generate(sources, outputs);
    const second = generate(sources, outputs);
    expect(second.builtins.length).toBe(first.builtins.length);
    expect(first.keywords).toContain('model');
    expect(first.keywords).toContain('forward');
    expect(first.builtins.find(b => b.name === 'Linear')).toBeTruthy();
    expect(first.builtins.find(b => b.name === 'Adam')).toBeTruthy();
    const data = JSON.parse(readFileSync(outputs.languageData, 'utf8'));
    expect(data.builtins.find(b => b.name === 'Linear').signature.display).toMatch(/Linear\(/);
    expect(data.builtins.find(b => b.name === 'Linear').description).toBeTruthy();
    expect(data.builtins.find(b => b.name === 'cpu').description).toBeTruthy();
  });

  it('extracts type names and type operators', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tera-gen-'));
    const outputs = {
      grammar: join(tmp, 'grammar.json'),
      languageData: join(tmp, 'language-data.json'),
      snippets: join(tmp, 'snippets.json'),
    };
    const sources = {
      parser: join(REPO_ROOT, 'src/cli/parser.js'),
      tokenizer: join(REPO_ROOT, 'src/cli/tokenizer.js'),
      builtins: join(REPO_ROOT, 'src/cli/builtins.js'),
      builtinDocs: join(REPO_ROOT, 'vscode-ext/data/builtin-docs.md'),
    };
    const result = generate(sources, outputs);
    expect(result.keywords).toContain('int');
    expect(result.keywords).toContain('Tensor');
    expect(result.keywords).toContain('string');
    expect(result.keywords).toContain('Record');
    expect(result.operators.twoChar).toContain('->');
    expect(result.operators.oneChar).toContain('|');
    const grammar = JSON.parse(readFileSync(outputs.grammar, 'utf8'));
    expect(JSON.stringify(grammar)).toContain('storage.type.tera');
    const data = JSON.parse(readFileSync(outputs.languageData, 'utf8'));
    expect(data.keywordGroups.type).toContain('int');
  });

  it('shows param types and return types in builtin signatures', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tera-gen-'));
    const outputs = {
      grammar: join(tmp, 'grammar.json'),
      languageData: join(tmp, 'language-data.json'),
      snippets: join(tmp, 'snippets.json'),
    };
    const sources = {
      parser: join(REPO_ROOT, 'src/cli/parser.js'),
      tokenizer: join(REPO_ROOT, 'src/cli/tokenizer.js'),
      builtins: join(REPO_ROOT, 'src/cli/builtins.js'),
      builtinDocs: join(REPO_ROOT, 'vscode-ext/data/builtin-docs.md'),
    };
    generate(sources, outputs);
    const data = JSON.parse(readFileSync(outputs.languageData, 'utf8'));
    const linear = data.builtins.find(b => b.name === 'Linear');
    expect(linear.signature.display).toContain('in: int');
    expect(linear.signature.display).toContain('-> Linear');
    expect(data.builtins.find(b => b.name === 'Adam').signature.display).toContain('-> Optimizer');
    expect(data.builtins.find(b => b.name === 'zeros').signature.display).toContain('shape: int[]');
    expect(data.builtins.find(b => b.name === 'cat').signature.display).toContain('-> Tensor');
    expect(data.builtins.find(b => b.name === 'range').signature.display).toContain('-> int[]');
    const tok = data.builtins.find(b => b.name === 'Tokenizer');
    expect(tok.methods.find(m => m.name === 'padId').returns).toBe('int');
    expect(tok.methods.find(m => m.name === 'encode').returns).toBe('int[]');
    expect(tok.methods.find(m => m.name === 'save').returns).toBe('none');
    expect(tok.methods.find(m => m.name === 'load')).toBeUndefined();
    expect(data.builtins.find(b => b.name === 'load_tokenizer').signature.display).toContain('-> Tokenizer');
    expect(data.builtins.find(b => b.name === 'save')).toBeUndefined();
    expect(data.pseudoTypes.Model.find(m => m.name === 'to').returns).toBe('Model');
    expect(data.pseudoTypes.Model.find(m => m.name === 'save').returns).toBe('none');
  });
});
