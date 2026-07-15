export const DEFAULT_FRAME_DURATION_MS = 900;
export const DEFAULT_EASING = 'cubic';
export const TARGET_FPS = 60;

const HALF = 0.5;

const easeInOutQuad = t => (t < HALF ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const easeInOutCubic = t => (t < HALF ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeInOutSine = t => -(Math.cos(Math.PI * t) - 1) / 2;

const EASINGS = {
  linear: t => t,
  ease: easeInOutQuad,
  'ease-in-out': easeInOutSine,
  cubic: easeInOutCubic,
};

export const EASING_NAMES = Object.keys(EASINGS);

export function getEasing(name) {
  return EASINGS[name] ?? EASINGS[DEFAULT_EASING];
}

export function normalizeEasing(name) {
  return EASINGS[name] ? name : DEFAULT_EASING;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function lerpColor(a, b, t) {
  if (a === b || a == null || b == null) return b ?? a;
  const from = hexToRgb(a);
  const to = hexToRgb(b);
  if (!from || !to) return b;
  return rgbToHex([lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)]);
}

export function segmentAt(frameCount, fraction) {
  if (frameCount < 2) return { from: 0, to: 0, t: 0, index: 0 };
  const clamped = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
  const position = clamped * (frameCount - 1);
  let from = Math.floor(position);
  if (from >= frameCount - 1) from = frameCount - 2;
  return { from, to: from + 1, t: position - from, index: Math.round(position) };
}

export function indexMarks(series) {
  const map = new Map();
  for (const item of series) {
    for (const point of item.points) {
      const key = String(point.key ?? `${item.name}:${point.x}`);
      map.set(key, { key, x: point.x, y: point.y, size: point.size, color: item.color, name: item.name, point });
    }
  }
  return map;
}

export function unionKeys(maps) {
  const keys = new Set();
  for (const map of maps) {
    for (const key of map.keys()) keys.add(key);
  }
  return [...keys];
}

export function tweenMark(from, to, t) {
  if (from && to) {
    return {
      x: lerp(from.x, to.x, t),
      y: lerp(from.y, to.y, t),
      size: lerp(from.size ?? 0, to.size ?? 0, t),
      color: lerpColor(from.color, to.color, t),
      opacity: 1,
      name: to.name,
      point: to.point,
    };
  }
  if (to) return { x: to.x, y: to.y, size: to.size, color: to.color, opacity: t, name: to.name, point: to.point };
  if (from) return { x: from.x, y: from.y, size: from.size, color: from.color, opacity: 1 - t, name: from.name, point: from.point };
  return { opacity: 0 };
}

export function tweenLinePath(from, to, t, x, y) {
  const count = Math.max(from.length, to.length);
  if (count === 0) return '';
  let path = '';
  for (let i = 0; i < count; i += 1) {
    const a = from[Math.min(i, from.length - 1)] ?? to[Math.min(i, to.length - 1)];
    const b = to[Math.min(i, to.length - 1)] ?? a;
    const px = x.scale(lerp(a.x, b.x, t));
    const py = y.scale(lerp(a.y, b.y, t));
    path += `${i === 0 ? 'M' : 'L'}${px},${py}`;
  }
  return path;
}

function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  if (!Number.isFinite(value)) return null;
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHex(rgb) {
  return `#${rgb.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}
