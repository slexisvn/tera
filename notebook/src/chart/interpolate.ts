import type { ChartPoint, ChartScale, ChartSeries } from './types';

export const DEFAULT_FRAME_DURATION_MS = 900;
export const DEFAULT_EASING = 'cubic';
export const TARGET_FPS = 60;

const HALF = 0.5;

type EasingName = keyof typeof EASINGS;
type Easing = (t: number) => number;
type Rgb = [number, number, number];
type Segment = { from: number; to: number; t: number; index: number };
type TweenMark = {
  key?: string;
  x?: number;
  y?: number;
  size?: number;
  color?: string;
  opacity: number;
  name?: string;
  point?: ChartPoint;
};
type MarkMap = Map<string, TweenMark>;

const easeInOutQuad = (t: number) => (t < HALF ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const easeInOutCubic = (t: number) => (t < HALF ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;

const EASINGS = {
  linear: (t: number) => t,
  ease: easeInOutQuad,
  'ease-in-out': easeInOutSine,
  cubic: easeInOutCubic,
};

export const EASING_NAMES = Object.keys(EASINGS);

export function getEasing(name: unknown): Easing {
  return EASINGS[normalizeEasing(name)];
}

export function normalizeEasing(name: unknown): EasingName {
  return typeof name === 'string' && name in EASINGS ? name as EasingName : DEFAULT_EASING;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpColor(a: string | undefined, b: string | undefined, t: number): string | undefined {
  if (a === b || a == null || b == null) return b ?? a;
  const from = hexToRgb(a);
  const to = hexToRgb(b);
  if (!from || !to) return b;
  return rgbToHex([lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)]);
}

export function segmentAt(frameCount: number, fraction: number): Segment {
  if (frameCount < 2) return { from: 0, to: 0, t: 0, index: 0 };
  const clamped = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
  const position = clamped * (frameCount - 1);
  let from = Math.floor(position);
  if (from >= frameCount - 1) from = frameCount - 2;
  return { from, to: from + 1, t: position - from, index: Math.round(position) };
}

export function indexMarks(series: ChartSeries[]): MarkMap {
  const map: MarkMap = new Map();
  for (const item of series) {
    for (const point of item.points) {
      const key = String(point.key ?? `${item.name}:${point.x}`);
      if (typeof point.x === 'number') map.set(key, { key, x: point.x, y: point.y, size: point.size, color: item.color, opacity: 1, name: item.name, point });
    }
  }
  return map;
}

export function unionKeys(maps: Array<Map<string, unknown>>): string[] {
  const keys = new Set();
  for (const map of maps) {
    for (const key of map.keys()) keys.add(key);
  }
  return [...keys] as string[];
}

export function tweenMark(from: TweenMark | undefined, to: TweenMark | undefined, t: number): TweenMark {
  if (from && to) {
    return {
      x: lerp(from.x ?? 0, to.x ?? 0, t),
      y: lerp(from.y ?? 0, to.y ?? 0, t),
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

export function tweenLinePath(from: ChartPoint[], to: ChartPoint[], t: number, x: ChartScale, y: ChartScale): string {
  const count = Math.max(from.length, to.length);
  if (count === 0) return '';
  let path = '';
  for (let i = 0; i < count; i += 1) {
    const a = from[Math.min(i, from.length - 1)] ?? to[Math.min(i, to.length - 1)];
    const b = to[Math.min(i, to.length - 1)] ?? a;
    const ax = typeof a.x === 'number' ? a.x : 0;
    const bx = typeof b.x === 'number' ? b.x : ax;
    const px = x.scale(lerp(ax, bx, t));
    const py = y.scale(lerp(a.y, b.y, t));
    path += `${i === 0 ? 'M' : 'L'}${px},${py}`;
  }
  return path;
}

function hexToRgb(hex: string): Rgb | null {
  const value = parseInt(hex.slice(1), 16);
  if (!Number.isFinite(value)) return null;
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}
