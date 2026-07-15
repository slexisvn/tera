function normalizeIndex(i, length) {
  return i < 0 ? i + length : i;
}

function popList(arr, i) {
  if (arr.length === 0) throw new Error('pop from empty list');
  const idx = normalizeIndex(i === undefined ? arr.length - 1 : i, arr.length);
  if (idx < 0 || idx >= arr.length) throw new Error(`pop index ${i} is out of bounds for list of length ${arr.length}`);
  return arr.splice(idx, 1)[0];
}

function insertList(arr, i, x) {
  let idx = normalizeIndex(i, arr.length);
  if (idx < 0) idx = 0;
  if (idx > arr.length) idx = arr.length;
  arr.splice(idx, 0, x);
  return null;
}

function removeList(arr, x) {
  const idx = arr.indexOf(x);
  if (idx !== -1) arr.splice(idx, 1);
  return null;
}

function countList(arr, x) {
  let n = 0;
  for (const item of arr) if (item === x) n += 1;
  return n;
}

const LIST_METHODS = {
  append: (arr, x) => { arr.push(x); return null; },
  extend: (arr, other) => { for (const item of other) arr.push(item); return null; },
  insert: insertList,
  pop: popList,
  remove: removeList,
  index: (arr, x) => arr.indexOf(x),
  count: countList,
  contains: (arr, x) => arr.indexOf(x) !== -1,
  reverse: (arr) => { arr.reverse(); return null; },
  clear: (arr) => { arr.length = 0; return null; },
  copy: (arr) => arr.slice(),
};

function splitString(s, sep) {
  if (sep === undefined) {
    const trimmed = s.trim();
    return trimmed === '' ? [] : trimmed.split(/\s+/);
  }
  return s.split(sep);
}

const STRING_METHODS = {
  upper: (s) => s.toUpperCase(),
  lower: (s) => s.toLowerCase(),
  strip: (s) => s.trim(),
  lstrip: (s) => s.replace(/^\s+/, ''),
  rstrip: (s) => s.replace(/\s+$/, ''),
  split: splitString,
  join: (sep, parts) => parts.join(sep),
  replace: (s, oldValue, newValue) => s.split(oldValue).join(newValue),
  starts_with: (s, prefix) => s.startsWith(prefix),
  ends_with: (s, suffix) => s.endsWith(suffix),
  find: (s, sub) => s.indexOf(sub),
  contains: (s, sub) => s.includes(sub),
};

const DICT_METHODS = {
  keys: (m) => [...m.keys()],
  values: (m) => [...m.values()],
  items: (m) => [...m.entries()].map(([k, v]) => [k, v]),
  get: (m, key, fallback) => (m.has(key) ? m.get(key) : (fallback === undefined ? null : fallback)),
  has: (m, key) => m.has(key),
  remove: (m, key) => { m.delete(key); return null; },
};

export function lookupCollectionMethod(object, property) {
  let table;
  if (Array.isArray(object)) table = LIST_METHODS;
  else if (typeof object === 'string') table = STRING_METHODS;
  else if (object instanceof Map) table = DICT_METHODS;
  else return undefined;
  const fn = table[property];
  if (!fn) return undefined;
  return (...args) => fn(object, ...args);
}
