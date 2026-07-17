export type ChartPointLike = {
  x?: string | number;
  y?: number;
  y0?: number;
  y1?: number;
  x0?: number;
  x1?: number;
  key?: string | number;
  size?: number;
  value?: string | number;
  count?: number;
  color?: string;
  tooltip?: string | null;
};

export type ChartDimension = string | number;

export type ChartPoint = {
  x: ChartDimension;
  y: number;
  y0?: number;
  y1?: number;
  x0?: number;
  x1?: number;
  key?: ChartDimension;
  size?: number;
  value?: ChartDimension;
  count?: number;
  color?: string;
  tooltip?: string | null;
};

export type ChartSeries = {
  name: string;
  points: ChartPoint[];
  color?: string;
  index?: number;
  dash?: boolean;
  fit?: unknown;
  missing?: number;
  count?: number;
  bandwidth?: number;
};

export type ChartRule = {
  value: number;
  label: string | null;
  color: string;
  dash: boolean;
  width: number;
};

export type ChartOptions = {
  title?: string | null;
  xLabel?: string | null;
  yLabel?: string | null;
  y2Label?: string | null;
  width?: number | null;
  height?: number | null;
  legend?: boolean;
  zoom?: boolean;
  mode?: string | null;
  dash?: boolean;
  animate?: boolean;
  anim?: {
    durationMs: number;
    easing: string;
    loop: boolean;
    speed: number;
    autoplay: boolean;
  };
  hlines?: ChartRule[];
  vlines?: ChartRule[];
  [key: string]: unknown;
};

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

export type TabularRow = Record<string, unknown>;

export type DataFrameLike = {
  select(...columns: string[]): {
    collect(): Promise<TabularRow[]>;
  };
  collect(): Promise<TabularRow[]>;
  count(): Promise<number> | number;
  columns?: () => Promise<string[]>;
  schema?: {
    fields?: Array<{ name: string; dataType?: string }>;
    _fields?: Array<{ name: string; dataType?: string }>;
  } | (() => { fields?: Array<{ name: string; dataType?: string }>; _fields?: Array<{ name: string; dataType?: string }> });
};

export type TensorLike = {
  shape: number[];
  toArray(): unknown[];
};

export type ChartConfig = {
  x?: unknown;
  y?: unknown;
  color?: unknown;
  bins?: unknown;
  size?: unknown;
  frame?: unknown;
  key?: unknown;
  method?: unknown;
  step?: unknown;
  value?: unknown;
  mode?: unknown;
  [key: string]: unknown;
};

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
