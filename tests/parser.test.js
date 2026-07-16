import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser.js';

describe('Tera parser', () => {
  it('preserves source locations on AST nodes', () => {
    const program = parse('\nvalue = missing(1)');
    expect(program.body[0]).toMatchObject({ type: 'Assign', line: 2, column: 1 });
    expect(program.body[0].value.callee).toMatchObject({ type: 'Identifier', line: 2, column: 9 });
  });

  it('parses multidimensional slices', () => {
    const expression = parse('x[:, 1:4:2]').body[0].expression;
    expect(expression.type).toBe('Index');
    expect(expression.items[0]).toMatchObject({ type: 'Slice', start: null, end: null, step: null });
    expect(expression.items[1]).toMatchObject({ type: 'Slice' });
  });

  it('parses logical operators with correct precedence', () => {
    const expr = parse('a == 1 and b == 2').body[0].expression;
    expect(expr).toMatchObject({ type: 'Binary', op: 'and' });
    expect(expr.left).toMatchObject({ type: 'Binary', op: '==' });
    expect(expr.right).toMatchObject({ type: 'Binary', op: '==' });
  });

  it('parses not with higher precedence than and', () => {
    const expr = parse('not a and b').body[0].expression;
    expect(expr).toMatchObject({ type: 'Binary', op: 'and' });
    expect(expr.left).toMatchObject({ type: 'Unary', op: 'not' });
  });

  it('treats a string literal of "-" or "+" as a string, not a unary operator', () => {
    expect(parse('x = "-"').body[0].value).toMatchObject({ type: 'Literal', value: '-' });
    expect(parse('x = "+"').body[0].value).toMatchObject({ type: 'Literal', value: '+' });
    const call = parse('s = "-".join(["a", "b"])').body[0].value;
    expect(call).toMatchObject({ type: 'Call' });
    expect(call.callee).toMatchObject({ type: 'Member', property: 'join' });
    expect(call.callee.object).toMatchObject({ type: 'Literal', value: '-' });
  });

  it('parses or with lower precedence than and', () => {
    const expr = parse('a and b or c').body[0].expression;
    expect(expr).toMatchObject({ type: 'Binary', op: 'or' });
    expect(expr.left).toMatchObject({ type: 'Binary', op: 'and' });
  });

  it('parses compound assignment operators', () => {
    const stmt = parse('x += 1').body[0];
    expect(stmt).toMatchObject({ type: 'CompoundAssign', name: 'x', op: '+' });
  });

  it('parses **= compound assignment', () => {
    const stmt = parse('x **= 2').body[0];
    expect(stmt).toMatchObject({ type: 'CompoundAssign', name: 'x', op: '**' });
  });

  it('parses function declarations', () => {
    const stmt = parse('fn add(a, b): return a + b').body[0];
    expect(stmt).toMatchObject({ type: 'FunctionDeclaration', name: 'add', params: ['a', 'b'] });
    expect(stmt.body).toHaveLength(1);
    expect(stmt.body[0]).toMatchObject({ type: 'Return' });
  });

  it('parses function declarations with no params', () => {
    const stmt = parse('fn greet(): print("hi")').body[0];
    expect(stmt).toMatchObject({ type: 'FunctionDeclaration', name: 'greet', params: [] });
  });

  it('parses if/else if/else', () => {
    const stmt = parse(`if a:
  b
else if c:
  d
else:
  e`).body[0];
    expect(stmt).toMatchObject({ type: 'If' });
    expect(stmt.elifs).toHaveLength(1);
    expect(stmt.elseBody).toHaveLength(1);
  });

  it('parses for...in', () => {
    const stmt = parse('for i in items: print(i)').body[0];
    expect(stmt).toMatchObject({ type: 'For', variable: 'i' });
    expect(stmt.iterable).toMatchObject({ type: 'Identifier', name: 'items' });
  });

  it('parses while', () => {
    const stmt = parse('while x > 0: x -= 1').body[0];
    expect(stmt).toMatchObject({ type: 'While' });
    expect(stmt.condition).toMatchObject({ type: 'Binary', op: '>' });
  });

  it('parses break and continue', () => {
    const program = parse('break\ncontinue');
    expect(program.body[0]).toMatchObject({ type: 'Break' });
    expect(program.body[1]).toMatchObject({ type: 'Continue' });
  });

  it('accepts trailing commas in arrays, calls, parameters, and indices', () => {
    expect(() => parse(`model MLP(input, hidden,):
  forward x,:
    return tensor([
      [1, 2],
      [3, 4],
    ],)[0,]`)).not.toThrow();
  });
});
