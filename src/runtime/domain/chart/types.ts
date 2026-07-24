export type ChartDimension = string | number;

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

export type ChartAnimation = {
  durationMs: number;
  easing: string;
  loop: boolean;
  speed: number;
  autoplay: boolean;
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
  anim?: ChartAnimation;
  hlines?: ChartRule[];
  vlines?: ChartRule[];
  [key: string]: unknown;
};

export type TabularRow = Record<string, unknown>;

export type DataFrameLike = {
  select(...columns: string[]): {
    collect(): Promise<TabularRow[]>;
  };
  collect(): Promise<TabularRow[]>;
  count(): Promise<number> | number;
  columns?: () => Promise<string[]> | string[];
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
