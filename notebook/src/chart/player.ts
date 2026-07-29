import { DEFAULT_DURATION_MS, DEFAULT_SPEED, normalizeSpeed, SPEED_OPTIONS } from '../../../src/runtime/domain/chart/animation';
import type { PlayerOptions } from './types';

export { DEFAULT_DURATION_MS, DEFAULT_SPEED, normalizeSpeed, SPEED_OPTIONS };

const FRACTION_MIN = 0;
const FRACTION_MAX = 1;

export function createPlayer({ duration = DEFAULT_DURATION_MS, speed: initialSpeed = DEFAULT_SPEED, loop: initialLoop = false, initialFraction = FRACTION_MAX, onUpdate }: PlayerOptions = {}) {
  let fraction = clampFraction(initialFraction);
  let speed = normalizeSpeed(initialSpeed);
  let loop = initialLoop === true;
  let playing = false;
  let raf = 0;
  let lastTime = 0;

  const snapshot = () => ({ fraction, speed, loop, playing });
  const emit = () => onUpdate?.(snapshot());

  const step = (now: number) => {
    if (!playing) return;
    const delta = lastTime ? now - lastTime : 0;
    lastTime = now;
    fraction += (delta / duration) * speed;
    if (fraction >= FRACTION_MAX) {
      if (loop) {
        fraction = FRACTION_MIN;
        emit();
        raf = requestAnimationFrame(step);
        return;
      }
      fraction = FRACTION_MAX;
      playing = false;
      raf = 0;
      emit();
      return;
    }
    emit();
    raf = requestAnimationFrame(step);
  };

  const play = () => {
    if (playing) return;
    if (fraction >= FRACTION_MAX) fraction = FRACTION_MIN;
    playing = true;
    lastTime = 0;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(step);
    emit();
  };

  const pause = () => {
    if (!playing) return;
    playing = false;
    cancelAnimationFrame(raf);
    raf = 0;
    emit();
  };

  const toggle = () => (playing ? pause() : play());

  const seek = (value: number) => {
    fraction = clampFraction(value);
    emit();
  };

  const setSpeed = (value: number) => {
    speed = normalizeSpeed(value);
    emit();
  };

  const setLoop = (value: boolean) => {
    loop = value === true;
    emit();
  };

  const destroy = () => {
    playing = false;
    cancelAnimationFrame(raf);
    raf = 0;
  };

  return {
    play,
    pause,
    toggle,
    seek,
    setSpeed,
    setLoop,
    destroy,
    snapshot,
    get fraction() {
      return fraction;
    },
    get playing() {
      return playing;
    },
  };
}

function clampFraction(value: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return FRACTION_MIN;
  if (number < FRACTION_MIN) return FRACTION_MIN;
  if (number > FRACTION_MAX) return FRACTION_MAX;
  return number;
}
