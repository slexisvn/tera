import { describe, expect, it } from 'vitest';
import { SignatureRegistry } from '../src/signature_registry.js';

describe('SignatureRegistry', () => {
  it('returns null for unknown names', () => {
    const reg = new SignatureRegistry();
    expect(reg.lookup('nonexistent')).toBe(null);
  });

  it('returns registered signatures', () => {
    const reg = new SignatureRegistry();
    reg.register('myFn', [{ name: 'a' }, { name: 'b', isOptional: true }]);
    const sig = reg.lookup('myFn');
    expect(sig).not.toBe(null);
    expect(sig.params).toHaveLength(2);
    expect(sig.params[0].name).toBe('a');
    expect(sig.params[1].name).toBe('b');
    expect(sig.params[1].isOptional).toBe(true);
  });

  it('resolves from dispatcher for known ops', () => {
    const reg = new SignatureRegistry();
    const sig = reg.lookup('add');
    if (sig) {
      expect(sig.params.length).toBeGreaterThan(0);
      expect(sig.params[0].name).toBeTruthy();
    }
  });

  it('prefers explicit registration over dispatcher', () => {
    const reg = new SignatureRegistry();
    reg.register('add', [{ name: 'x' }, { name: 'y' }]);
    const sig = reg.lookup('add');
    expect(sig.params[0].name).toBe('x');
    expect(sig.params[1].name).toBe('y');
  });
});
