export type ProtocolMessage = {
  seq: number;
  type: "request" | "response" | "event";
  [key: string]: unknown;
};

export type RequestMessage = ProtocolMessage & {
  type: "request";
  command: string;
  arguments?: Record<string, unknown>;
};

export type ResponseMessage = ProtocolMessage & {
  type: "response";
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: unknown;
};

export type EventMessage = ProtocolMessage & {
  type: "event";
  event: string;
  body?: unknown;
};

export type LaunchArguments = {
  program: string;
  cwd?: string;
  stopOnEntry?: boolean;
  typecheck?: "off" | "warn" | "strict";
};

export type BreakpointSpec = {
  id: number;
  sourceName: string;
  line: number;
  column: number | null;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
};

export type DapBreakpoint = {
  id: number;
  verified: boolean;
  line: number;
  column?: number;
  source?: DapSource;
};

export type DapSource = {
  name?: string;
  path?: string;
};

export type WorkerCommand =
  | {
      type: "start";
      launch: LaunchArguments;
      breakpoints: BreakpointSpec[];
    }
  | {
      type: "setBreakpoints";
      breakpoints: BreakpointSpec[];
    };

export type WorkerEvent =
  | { type: "started" }
  | { type: "stopped"; event: unknown }
  | { type: "output"; text: string; category?: string }
  | { type: "terminated" }
  | { type: "error"; message: string };
