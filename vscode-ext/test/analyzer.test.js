import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocumentAnalyzer } from '../server/analyzer/document_analyzer.js';
import { toDiagnostic } from '../server/providers/diagnostics.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, '../../examples');
const LANGUAGE_DATA = JSON.parse(readFileSync(join(HERE, '../language-data.json'), 'utf8'));

describe('DocumentAnalyzer', () => {
  it('parses examples without errors', () => {
    const analyzer = new DocumentAnalyzer();
    const sources = readdirSync(EXAMPLES).filter(f => f.endsWith('.tera'));
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const text = readFileSync(join(EXAMPLES, file), 'utf8');
      const doc = analyzer.update(`file://${file}`, text);
      expect(doc.errors, `errors in ${file}`).toEqual([]);
      expect(doc.ast).toBeTruthy();
      expect(doc.symbols.flat.length).toBeGreaterThan(0);
    }
  });

  it('reports diagnostic for syntax error', () => {
    const analyzer = new DocumentAnalyzer();
    const doc = analyzer.update('file://bad.tera', 'model Foo\n  forward x: x');
    expect(doc.errors.length).toBeGreaterThan(0);
    expect(doc.errors[0]).toHaveProperty('line');
    expect(doc.errors[0]).toHaveProperty('column');
  });

  it('captures model and field symbols', () => {
    const analyzer = new DocumentAnalyzer();
    const text = 'model MLP(hidden):\n  fc1 = Linear(784, hidden)\n  forward x:\n    return fc1(x)\n';
    const doc = analyzer.update('file://m.tera', text);
    const names = doc.symbols.flat.map(s => s.name);
    expect(names).toContain('MLP');
    expect(names).toContain('hidden');
    expect(names).toContain('fc1');
    expect(names).toContain('x');
  });

  it('points forward/train params at their identifier column', () => {
    const analyzer = new DocumentAnalyzer();
    const text = [
      'model Foo():',
      '  forward x:',
      '    return x',
      '  train batch:',
      '    a, b = batch',
      '    return a',
    ].join('\n');
    const doc = analyzer.update('file://p.tera', text);
    const xSym = doc.symbols.resolve('x', { line: 2, character: 12 });
    expect(xSym?.line).toBe(2);
    expect(xSym?.column).toBe(text.split('\n')[1].indexOf('x') + 1);
    const batchSym = doc.symbols.resolve('batch', { line: 4, character: 12 });
    expect(batchSym?.line).toBe(4);
    expect(batchSym?.column).toBe(text.split('\n')[3].indexOf('batch') + 1);
    const aSym = doc.symbols.resolve('a', { line: 5, character: 12 });
    expect(aSym?.line).toBe(5);
    expect(aSym?.column).toBe(text.split('\n')[4].indexOf('a') + 1);
  });

  it('points model and fn symbols at the name, not the keyword', () => {
    const analyzer = new DocumentAnalyzer();
    const text = 'model IrisNet():\n  fc = Linear(4, 3)\n  forward x: return fc(x)\n';
    const doc = analyzer.update('file://n.tera', text);
    const sym = doc.symbols.resolve('IrisNet', { line: 0, character: 8 });
    expect(sym).toBeTruthy();
    expect(sym.line).toBe(1);
    expect(sym.column).toBe(text.indexOf('IrisNet') + 1);
  });

  it('resolves variables to the innermost matching scope', () => {
    const analyzer = new DocumentAnalyzer();
    const text = [
      'x = 1',
      'fn outer():',
      '  x = 2',
      '  y = x',
      'fn other():',
      '  z = x',
      '',
    ].join('\n');
    const doc = analyzer.update('file://r.tera', text);
    const insideOuter = doc.symbols.resolve('x', { line: 3, character: 6 });
    expect(insideOuter?.line).toBe(3);
    const insideOther = doc.symbols.resolve('x', { line: 5, character: 6 });
    expect(insideOther?.line).toBe(1);
  });
});

describe('DocumentAnalyzer type checking', () => {
  const analyzer = () => new DocumentAnalyzer(LANGUAGE_DATA);
  const typeErrors = doc => doc.errors.filter(e => e.source === 'typecheck');

  it('accepts well-typed code', () => {
    const doc = analyzer().update('file://good.tera', 'fn square(n: int) -> int:\n  return n * n');
    expect(typeErrors(doc)).toEqual([]);
  });

  it('flags a return-type violation at its location', () => {
    const doc = analyzer().update('file://bad.tera', 'fn f() -> Tensor:\n  return "hi"');
    const errors = typeErrors(doc);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].line).toBe(2);
  });

  it('flags undefined names', () => {
    const doc = analyzer().update('file://u.tera', 'missing(1)');
    expect(typeErrors(doc).some(e => e.message.includes("undefined name 'missing'"))).toBe(true);
  });

  it('stays parse-only without language data', () => {
    const doc = new DocumentAnalyzer().update('file://x.tera', 'missing(1)');
    expect(doc.errors.filter(e => e.source === 'typecheck')).toEqual([]);
  });

  it('records annotation types on symbols for hover', () => {
    const doc = analyzer().update('file://t.tera', 'fn f(x: int) -> Tensor:\n  return zeros([2])\ny: int[] = [1]');
    expect(doc.symbols.flat.find(s => s.name === 'x')?.typeName).toBe('int');
    expect(doc.symbols.flat.find(s => s.name === 'y')?.typeName).toBe('int[]');
    expect(doc.symbols.flat.find(s => s.name === 'f' && s.kind === 'function')?.typeName).toBe('Tensor');
  });

  it('does not flag the type operators as syntax errors', () => {
    const doc = analyzer().update('file://op.tera', 'fn pick(x: int | string) -> int:\n  return 1');
    expect(doc.errors.filter(e => e.source === 'Parser' || e.source === 'Tokenizer')).toEqual([]);
  });

  it('resolves a model field to its builtin type for member hover', () => {
    const text = 'model M():\n  enc = LSTM(2, 3, 1, true)\n  forward (x: Tensor) -> Tensor:\n    return enc(x)';
    const doc = analyzer().update('file://field.tera', text);
    expect(doc.symbols.resolveField('M', 'enc')?.typeName).toBe('LSTM');
    expect(doc.symbols.resolveField('M', 'missing')).toBeNull();
  });

  it('infers types for unannotated variables, loop vars, and index results', () => {
    const text = 'nums = [1, 2, 3]\ntotal = 0\nfor x in nums:\n  total += x\nv = nums[0]\nratio = total / 2\npies = [1.5, 2.5]';
    const doc = analyzer().update('file://infer.tera', text);
    const flat = doc.symbols.flat;
    expect(flat.find(s => s.name === 'nums')?.typeName).toBe('int[]');
    expect(flat.find(s => s.name === 'total')?.typeName).toBe('int');
    expect(flat.find(s => s.name === 'x')?.typeName).toBe('int');
    expect(flat.find(s => s.name === 'v')?.typeName).toBe('int');
    expect(flat.find(s => s.name === 'ratio')?.typeName).toBe('float');
    expect(flat.find(s => s.name === 'pies')?.typeName).toBe('float[]');
  });

  it('infers Tensor from factories, model calls, and tensor methods', () => {
    const text = [
      'model Net(c: int):',
      '  fc = Linear(4, c)',
      '  forward (x: Tensor) -> Tensor:',
      '    return fc(x)',
      'net = Net(2)',
      'images = randn([4, 4])',
      'logits = net(images)',
      'probs = logits.softmax(axis=1)',
    ].join('\n');
    const doc = analyzer().update('file://tensor.tera', text);
    const flat = doc.symbols.flat;
    expect(flat.find(s => s.name === 'images')?.typeName).toBe('Tensor');
    expect(flat.find(s => s.name === 'logits')?.typeName).toBe('Tensor');
    expect(flat.find(s => s.name === 'probs')?.typeName).toBe('Tensor');
    expect(flat.find(s => s.name === 'net')?.typeName).toBe('Net');
  });

  it('infers specific module types and tensor results from module calls', () => {
    const text = [
      'embed = Embedding(10, 4)',
      'fc = Linear(4, 2)',
      'enc = LSTM(4, 8, 1, true)',
      'y = fc(embed(tensor([1])))',
    ].join('\n');
    const doc = analyzer().update('file://mods.tera', text);
    const flat = doc.symbols.flat;
    expect(flat.find(s => s.name === 'embed')?.typeName).toBe('Embedding');
    expect(flat.find(s => s.name === 'fc')?.typeName).toBe('Linear');
    expect(flat.find(s => s.name === 'enc')?.typeName).toBe('LSTM');
    expect(flat.find(s => s.name === 'y')?.typeName).toBe('Tensor');
  });

  it('infers tokenizer properties and model .to()', () => {
    const text = [
      'model Net(v: int):',
      '  fc = Linear(2, v)',
      '  forward (x: Tensor) -> Tensor:',
      '    return fc(x)',
      'tok = Tokenizer(mode="bpe")',
      'loaded = load_tokenizer("tokenizer.json")',
      'pad = tok.padId',
      'vs = tok.vocabSize',
      'ids = tok.encode("hi")',
      'net = Net(tok.vocabSize)',
      'moved = net.to(device="gpu")',
    ].join('\n');
    const doc = analyzer().update('file://tok.tera', text);
    const flat = doc.symbols.flat;
    expect(doc.errors.filter(e => e.source === 'typecheck')).toEqual([]);
    expect(flat.find(s => s.name === 'tok')?.typeName).toBe('Tokenizer');
    expect(flat.find(s => s.name === 'loaded')?.typeName).toBe('Tokenizer');
    expect(flat.find(s => s.name === 'pad')?.typeName).toBe('int');
    expect(flat.find(s => s.name === 'ids')?.typeName).toBe('int[]');
    expect(flat.find(s => s.name === 'moved')?.typeName).toBe('Model');
  });

  it('flags log() called outside train/validate but allows it inside', () => {
    const text = [
      'model Reg:',
      '  fc = Linear(4, 1)',
      '  loss_fn = MSELoss()',
      '  forward (x: Tensor) -> Tensor:',
      '    return fc(x)',
      '  train (b: Tensor[]):',
      '    p, q = b',
      '    loss = loss_fn(Reg(p), q)',
      '    log("train_loss", loss, prog_bar=true)',
      '    return loss',
      'net = Reg()',
      'log("name", "value")',
    ].join('\n');
    const doc = analyzer().update('file://log.tera', text);
    const logErrors = doc.errors.filter(e => e.source === 'typecheck' && /inside a train or validate/.test(e.message));
    expect(logErrors).toHaveLength(1);
    expect(doc.errors.some(e => /undefined name 'log'/.test(e.message))).toBe(false);
  });

  it('infers model field member access across functions', () => {
    const text = [
      'model Chat(v: int, h: int):',
      '  embed = Embedding(v, h)',
      '  encoder = LSTM(h, h, 1, true)',
      '  forward (q: Tensor) -> Tensor:',
      '    return embed(q)',
      'fn reply(m: Chat, q: Tensor) -> Tensor:',
      '  enc, state = m.encoder(m.embed(q))',
      '  return enc',
    ].join('\n');
    const doc = analyzer().update('file://field.tera', text);
    const flat = doc.symbols.flat;
    expect(flat.find(s => s.name === 'enc')?.typeName).toBe('Tensor');
    expect(flat.find(s => s.name === 'state')?.typeName).toBe('Tensor');
    expect(doc.symbols.scopes.find(s => s.name === 'Chat')?.symbols.filter(x => x.kind === 'variable').map(x => x.name))
      .toEqual(['embed', 'encoder']);
  });

  it('infers tensors from an RNN call destructuring', () => {
    const text = [
      'model Chat(v: int, h: int):',
      '  embed = Embedding(v, h)',
      '  encoder = LSTM(h, h, 1, true)',
      '  forward (q: Tensor) -> Tensor:',
      '    enc, enc_state = encoder(embed(q))',
      '    return enc',
    ].join('\n');
    const doc = analyzer().update('file://rnn.tera', text);
    const flat = doc.symbols.flat;
    expect(flat.find(s => s.name === 'enc')?.typeName).toBe('Tensor');
    expect(flat.find(s => s.name === 'enc_state')?.typeName).toBe('Tensor');
  });

  it('infers DataFrame/GroupedData through method chains', () => {
    const text = [
      'sessions = load_csv("x.csv")',
      'labeled = sessions.withColumn("seg", expr("x"))',
      'grp = sessions.groupBy("a")',
      'agg = grp.agg(count("a"))',
    ].join('\n');
    const doc = analyzer().update('file://df.tera', text);
    const flat = doc.symbols.flat;
    expect(flat.find(s => s.name === 'sessions')?.typeName).toBe('DataFrame');
    expect(flat.find(s => s.name === 'labeled')?.typeName).toBe('DataFrame');
    expect(flat.find(s => s.name === 'grp')?.typeName).toBe('GroupedData');
    expect(flat.find(s => s.name === 'agg')?.typeName).toBe('DataFrame');
  });

  it('diagnostic range spans the whole offending token, not one char', () => {
    const text = 'fn f(n: int) -> int:\n  return n\nf("4")';
    const doc = analyzer().update('file://span.tera', text);
    const err = typeErrors(doc).find(e => e.line === 3);
    expect(err).toBeTruthy();
    const diag = toDiagnostic(err, doc);
    // the argument is `"4"` (3 chars) on line 3 → range must be 3 wide, not 1
    expect(diag.range.end.character - diag.range.start.character).toBe(3);
    expect(diag.range.start.line).toBe(2);
  });
});
