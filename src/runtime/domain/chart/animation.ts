export const DEFAULT_FRAME_DURATION_MS = 900;
export const DEFAULT_DURATION_MS = 2200;
export const DEFAULT_EASING = "cubic";
export const DEFAULT_SPEED = 1;
export const SPEED_OPTIONS = [0.5, 1, 2, 4];

const HALF = 0.5;

export type Easing = (t: number) => number;

const EASINGS = {
  linear: (t: number) => t,
  ease: (t: number) => (t < HALF ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  "ease-in-out": (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
  cubic: (t: number) => (t < HALF ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
};

export type EasingName = keyof typeof EASINGS;

export const EASING_NAMES = Object.keys(EASINGS);

export function normalizeEasing(name: unknown): EasingName {
  return typeof name === "string" && name in EASINGS ? name as EasingName : DEFAULT_EASING;
}

export function getEasing(name: unknown): Easing {
  return EASINGS[normalizeEasing(name)];
}

export function normalizeSpeed(value: number): number {
  return SPEED_OPTIONS.includes(value) ? value : DEFAULT_SPEED;
}
