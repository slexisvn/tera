import { createPlayer, DEFAULT_DURATION_MS, DEFAULT_SPEED, SPEED_OPTIONS } from './player';
import type { ChartAnimationOptions, ChartPointLike, ChartScale, PlayerState } from './types';

const PERCENT_SCALE = 100;
const SLIDER_MIN = 0;
const SLIDER_MAX = 1;
const SLIDER_STEP = 0.001;
const FULL_FRACTION = 1;

export function isBrowserAnimation() {
  return typeof window !== 'undefined' && typeof document !== 'undefined' && typeof requestAnimationFrame !== 'undefined';
}

export function shouldAnimate(enabled: boolean, type: string, animatableTypes: Set<string>) {
  if (enabled !== true) return false;
  if (!animatableTypes.has(type)) return false;
  if (!isBrowserAnimation()) return false;
  if (prefersReducedMotion()) return false;
  return true;
}

export function revealPoints<T extends ChartPointLike>(points: T[], fraction: number, scale: ChartScale | null) {
  if (fraction >= FULL_FRACTION || points.length === 0) return points;
  if (scale && scale.type === 'linear') {
    const [min, max] = scale.domain;
    const threshold = min + fraction * (max - min);
    let count = 0;
    while (count < points.length && Number(points[count].x) <= threshold) count += 1;
    return points.slice(0, Math.max(1, count));
  }
  const count = Math.max(1, Math.round(points.length * fraction));
  return points.slice(0, Math.min(points.length, count));
}

export function createAnimationController(host: HTMLElement, options: ChartAnimationOptions = {}) {
  const { duration = DEFAULT_DURATION_MS, loop = false, speed = DEFAULT_SPEED, autoplay = false, frameValues = null } = options;
  const stage = document.createElement('div');
  stage.className = 'chart-anim-stage';
  let redraw: (() => void) | null = null;
  const transport = buildTransport(() => player, frameValues);
  const player = createPlayer({
    duration,
    loop,
    speed,
    onUpdate: (state: PlayerState) => {
      transport.sync(state);
      redraw?.();
    },
  });
  transport.sync(player.snapshot());
  host.innerHTML = '';
  host.className = 'chart-view';
  host.append(stage, transport.element);

  const onVisibility = () => {
    if (document.hidden) player.pause();
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    stage,
    fraction: () => player.fraction,
    setRedraw: (fn: () => void) => {
      redraw = fn;
    },
    start: () => {
      if (autoplay) player.play();
    },
    cleanup: () => {
      document.removeEventListener('visibilitychange', onVisibility);
      player.destroy();
    },
  };
}

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function buildTransport(getPlayer: () => ReturnType<typeof createPlayer>, frameValues: Array<string | number> | null) {
  const frameMode = Array.isArray(frameValues) && frameValues.length > 1;
  const lastFrame = frameMode ? frameValues.length - 1 : 0;
  const element = document.createElement('div');
  element.className = 'chart-transport';

  const playButton = document.createElement('button');
  playButton.type = 'button';
  playButton.className = 'chart-transport-play';
  playButton.addEventListener('click', () => getPlayer().toggle());

  const scrubber = document.createElement('input');
  scrubber.type = 'range';
  scrubber.className = 'chart-transport-scrubber';
  scrubber.min = String(frameMode ? 0 : SLIDER_MIN);
  scrubber.max = String(frameMode ? lastFrame : SLIDER_MAX);
  scrubber.step = String(frameMode ? 1 : SLIDER_STEP);
  scrubber.addEventListener('input', () => {
    getPlayer().pause();
    const raw = Number(scrubber.value);
    getPlayer().seek(frameMode ? raw / lastFrame : raw);
  });

  const label = document.createElement('span');
  label.className = 'chart-transport-label';

  const speedGroup = document.createElement('div');
  speedGroup.className = 'chart-transport-speed';
  const speedButtons = SPEED_OPTIONS.map(value => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${value}x`;
    button.addEventListener('click', () => getPlayer().setSpeed(value));
    speedGroup.append(button);
    return { value, button };
  });

  const loopButton = document.createElement('button');
  loopButton.type = 'button';
  loopButton.className = 'chart-transport-loop';
  loopButton.textContent = 'Loop';
  loopButton.addEventListener('click', () => getPlayer().setLoop(!getPlayer().snapshot().loop));

  element.append(playButton, scrubber, label, speedGroup, loopButton);

  const sync = (state: PlayerState) => {
    playButton.textContent = state.playing ? 'Pause' : 'Play';
    if (frameMode) {
      const index = Math.round(state.fraction * lastFrame);
      if (Number(scrubber.value) !== index) scrubber.value = String(index);
      label.textContent = String(frameValues[index]);
    } else {
      const next = String(state.fraction);
      if (scrubber.value !== next) scrubber.value = next;
      label.textContent = `${Math.round(state.fraction * PERCENT_SCALE)}%`;
    }
    for (const item of speedButtons) item.button.classList.toggle('active', item.value === state.speed);
    loopButton.classList.toggle('active', state.loop);
  };

  return { element, sync };
}
