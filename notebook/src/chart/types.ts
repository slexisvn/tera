export type {
  ChartAnimation,
  ChartConfig,
  ChartDimension,
  ChartOptions,
  ChartPoint,
  ChartPointLike,
  ChartRule,
  ChartSeries,
  DataFrameLike,
  TabularRow,
  TensorLike,
} from '../../../src/runtime/domain/chart/types';

import type { ChartDimension, ChartPoint, ChartSeries } from '../../../src/runtime/domain/chart/types';

export type ChartLayout = {
  width?: number;
  height?: number;
  frameRight?: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export type TooltipPoint = {
  x?: ChartDimension;
  y?: number;
  tooltip?: string | null;
};

export type TooltipSeries = {
  name: string;
};

export type TooltipApi = {
  bind(element: Element, point: TooltipPoint, series: TooltipSeries): void;
  track(event: PointerEvent, point: TooltipPoint, series: TooltipSeries): void;
  hide(): void;
  remove(): void;
};

export type RenderContext = {
  x: ChartScale;
  y: ChartScale;
  layout: ChartLayout;
  tooltip: TooltipApi;
  visibleSeriesCount: number;
  maxSeriesPoints: number;
  seriesOffset: number;
  stacked: boolean;
  allPoints: ChartPoint[];
};

export type ChartRenderer = (root: SVGElement, series: ChartSeries, context: RenderContext) => void;

export type ChartAnimationOptions = {
  duration?: number;
  loop?: boolean;
  speed?: number;
  autoplay?: boolean;
  frameValues?: Array<string | number> | null;
};

export type PlayerState = {
  fraction: number;
  speed: number;
  loop: boolean;
  playing: boolean;
};

export type PlayerOptions = {
  duration?: number;
  speed?: number;
  loop?: boolean;
  initialFraction?: number;
  onUpdate?: (state: PlayerState) => void;
};

export type LinearScale = {
  type: "linear";
  min: number;
  max: number;
  domain: [number, number];
  scale(value: string | number): number;
  invert(position: number): number;
  ticks: number[];
};

export type CategoryScale = {
  type: "category";
  domain: string[];
  step: number;
  scale(value: string | number): number;
  ticks: string[];
};

export type ChartScale = LinearScale | CategoryScale;
