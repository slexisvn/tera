export const ANY = Object.freeze({ kind: 'any' });
export const UNKNOWN = Object.freeze({ kind: 'unknown' });
export const INT = Object.freeze({ kind: 'number', num: 'int' });
export const FLOAT = Object.freeze({ kind: 'number', num: 'float' });
export const NUMBER = INT;
export const STRING = Object.freeze({ kind: 'string' });
export const BOOL = Object.freeze({ kind: 'bool' });
export const NULL = Object.freeze({ kind: 'null' });
export const NONE = Object.freeze({ kind: 'none' });
export const TENSOR = Object.freeze({ kind: 'tensor' });

export function listType(element) {
  return { kind: 'list', element: element ?? ANY };
}

export function dictType(key, value) {
  return { kind: 'dict', key: key ?? ANY, value: value ?? ANY };
}

export function functionType(params, ret, variadic = false, required = null, names = null) {
  const list = params ?? [];
  return { kind: 'function', params: list, ret: ret ?? ANY, variadic, required: required ?? list.length, names };
}

export function moduleType(name = '') {
  return { kind: 'module', name };
}

export function isAny(type) {
  return !type || type.kind === 'any' || type.kind === 'unknown';
}

export function typeToString(type) {
  switch (type.kind) {
    case 'list': {
      const element = typeToString(type.element);
      const wrap = type.element.kind === 'union' || type.element.kind === 'function';
      return wrap ? `(${element})[]` : `${element}[]`;
    }
    case 'dict': return `Record<${typeToString(type.key)}, ${typeToString(type.value)}>`;
    case 'number': return type.num === 'float' ? 'float' : 'int';
    case 'bool': return 'boolean';
    case 'module': return type.name || 'Module';
    case 'tensor': return 'Tensor';
    case 'function': return `(${type.params.map(typeToString).join(', ')}${type.variadic ? ', ...' : ''}) -> ${typeToString(type.ret)}`;
    case 'union': return type.members.map(typeToString).join(' | ');
    default: return type.kind;
  }
}

export function unionType(members) {
  const flat = [];
  for (const member of members) {
    if (member.kind === 'union') flat.push(...member.members);
    else flat.push(member);
  }
  if (flat.some(isAny)) return ANY;
  const unique = new Map();
  for (const member of flat) {
    const key = typeToString(member);
    if (!unique.has(key)) unique.set(key, member);
  }
  const values = [...unique.values()];
  if (values.length === 1) return values[0];
  return { kind: 'union', members: values };
}

export function join(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (isAny(a) || isAny(b)) return ANY;
  if (a.kind === 'number' && b.kind === 'number') return a.num === 'float' || b.num === 'float' ? FLOAT : INT;
  if (typeToString(a) === typeToString(b)) return a;
  return unionType([a, b]);
}

function functionAssignable(source, target) {
  const shared = Math.min(source.params.length, target.params.length);
  for (let i = 0; i < shared; i++) {
    if (!isAssignable(target.params[i], source.params[i])) return false;
  }
  return isAssignable(source.ret, target.ret);
}

export function isAssignable(source, target) {
  if (isAny(source) || isAny(target)) return true;
  if (target.kind === 'union') return target.members.some(member => isAssignable(source, member));
  if (source.kind === 'union') return source.members.every(member => isAssignable(member, target));
  if (source.kind === 'null' || source.kind === 'none') return target.kind === source.kind;
  if (source.kind !== target.kind) return false;
  switch (source.kind) {
    case 'list': return isAssignable(source.element, target.element);
    case 'dict': return isAssignable(source.key, target.key) && isAssignable(source.value, target.value);
    case 'module': return !source.name || !target.name || source.name === target.name;
    case 'function': return functionAssignable(source, target);
    default: return true;
  }
}
