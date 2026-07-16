import { describe, expect, it } from 'vitest';
import { parseCallContext } from '../src/call_context.js';

describe('parseCallContext', () => {
  it('returns null when not inside a call', () => {
    expect(parseCallContext('x = 5')).toBe(null);
    expect(parseCallContext('hello')).toBe(null);
    expect(parseCallContext('')).toBe(null);
  });

  it('detects function name and argIndex 0 at opening paren', () => {
    expect(parseCallContext('zeros(')).toEqual({ functionName: 'zeros', argIndex: 0 });
    expect(parseCallContext('compile(')).toEqual({ functionName: 'compile', argIndex: 0 });
  });

  it('counts commas to determine argIndex', () => {
    expect(parseCallContext('add(x, ')).toEqual({ functionName: 'add', argIndex: 1 });
    expect(parseCallContext('slice(t, 0, 1, ')).toEqual({ functionName: 'slice', argIndex: 3 });
  });

  it('handles nested calls by finding innermost unmatched paren', () => {
    expect(parseCallContext('compile(trace(fn, ')).toEqual({ functionName: 'trace', argIndex: 1 });
    expect(parseCallContext('add(zeros(')).toEqual({ functionName: 'zeros', argIndex: 0 });
  });

  it('ignores commas inside nested brackets', () => {
    expect(parseCallContext('zeros([2, 3], ')).toEqual({ functionName: 'zeros', argIndex: 1 });
    expect(parseCallContext('cat([a, b, c], ')).toEqual({ functionName: 'cat', argIndex: 1 });
  });

  it('ignores commas inside strings', () => {
    expect(parseCallContext('foo("a,b", ')).toEqual({ functionName: 'foo', argIndex: 1 });
  });

  it('handles dot-access method calls', () => {
    expect(parseCallContext('model.forward(')).toEqual({ functionName: 'forward', argIndex: 0 });
    expect(parseCallContext('x.reshape(')).toEqual({ functionName: 'reshape', argIndex: 0 });
  });

  it('returns null for bare open paren without identifier', () => {
    expect(parseCallContext('(')).toBe(null);
    expect(parseCallContext('  (')).toBe(null);
  });

  it('handles whitespace in arguments', () => {
    expect(parseCallContext('add(  x  ,  ')).toEqual({ functionName: 'add', argIndex: 1 });
  });
});
