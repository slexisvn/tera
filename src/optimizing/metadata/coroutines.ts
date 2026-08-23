import { CLASS_DATA_MEMBER } from "../../core/class-member.js";
import type { ClassMemberSurface, ClassSurface } from "../../frontend/modules/interface.js";
import { PENDING_THROW_TYPE } from "../builder/throw-recovery.js";
import type { ClassShape, ClassTable } from "./class-table.js";

export const CORO_FRAME_BASE = "tera_frame";
export const CORO_RESUME_TYPE = `(${"tera_frame"}) -> int`;
export const CORO_PROMISE_BASE = "tera_promise";
export const CORO_TIMER_SHAPE = "tera_timer";
export const CORO_SLEEP = "sleep";

export const CORO_ROUTINE_FIELD = "coroutine";
export const CORO_NEXT_FIELD = "next";
export const CORO_STATE_FIELD = "state";
export const CORO_RESULT_FIELD = "result";
export const CORO_VALUE_FIELD = "value";
export const CORO_ERROR_FIELD = "error";
export const CORO_WAITER_FIELD = "waiter";
export const CORO_WAITING_FIELD = "waiting";
export const CORO_UNREPORTED_FIELD = "unreported";
export const CORO_NEXT_REJECTED_FIELD = "nextRejected";
export const CORO_DUE_FIELD = "due";
export const CORO_TIMER_FIELD = "timer";

export const CORO_STATE_PENDING = 0;
export const CORO_STATE_RESOLVED = 1;
export const CORO_STATE_REJECTED = 2;
export const CORO_ENTRY_STATE = 0;
export const CORO_NOBODY_WAITING = 0;
export const CORO_SOMEONE_WAITING = 1;
export const CORO_REPORTED = 0;
export const CORO_UNREPORTED = 1;

export function coroutineFrameName(fn: string): string {
  return `${fn}$frame`;
}

export function coroutinePromiseName(fn: string): string {
  return `${fn}$promise`;
}

export function coroutineResumeName(fn: string): string {
  return `${fn}$resume`;
}

export function coroutineSlotName(index: number): string {
  return `slot${index}`;
}

export function coroutineParameterName(index: number): string {
  return `param${index}`;
}

function field(owner: string, name: string, declaredType: string): ClassMemberSurface {
  return {
    name,
    declaredType,
    member: CLASS_DATA_MEMBER,
    owner,
    abstract: false,
    visibility: "public",
    static: false,
  };
}

export function syntheticSurface(
  name: string,
  parent: string | null,
  fields: ReadonlyArray<readonly [string, string]>,
): ClassSurface {
  return {
    name,
    parent,
    abstract: false,
    members: fields.map(([member, declaredType]) => field(name, member, declaredType)),
    constructorParams: [],
    constructorParamNames: [],
  };
}

export function coroutineBaseShapes(classes: ClassTable): void {
  classes.defineSynthetic(
    syntheticSurface(CORO_FRAME_BASE, null, [
      [CORO_ROUTINE_FIELD, CORO_RESUME_TYPE],
      [CORO_STATE_FIELD, "int"],
      [CORO_NEXT_FIELD, CORO_FRAME_BASE],
    ]),
  );
  classes.defineSynthetic(
    syntheticSurface(CORO_PROMISE_BASE, null, [
      [CORO_STATE_FIELD, "int"],
      [CORO_WAITING_FIELD, "int"],
      [CORO_WAITER_FIELD, CORO_FRAME_BASE],
      [CORO_UNREPORTED_FIELD, "int"],
      [CORO_NEXT_REJECTED_FIELD, CORO_PROMISE_BASE],
      [CORO_ERROR_FIELD, PENDING_THROW_TYPE],
    ]),
  );
  classes.defineSynthetic(
    syntheticSurface(CORO_TIMER_SHAPE, CORO_PROMISE_BASE, [
      [CORO_DUE_FIELD, "float"],
      [CORO_TIMER_FIELD, CORO_TIMER_SHAPE],
    ]),
  );
}

export function coroutineTimerShape(classes: ClassTable): ClassShape {
  return classes.shapeOf(CORO_TIMER_SHAPE)!;
}

export function coroutinePromiseShape(
  classes: ClassTable,
  fn: string,
  returns: string,
): ClassShape {
  return classes.defineSynthetic(
    syntheticSurface(coroutinePromiseName(fn), CORO_PROMISE_BASE, [[CORO_VALUE_FIELD, returns]]),
  );
}

export function coroutineCarriesValue(promise: ClassShape): boolean {
  return promise.fields.has(CORO_VALUE_FIELD);
}

export interface CoroutineSlot {
  readonly name: string;
  readonly declaredType: string;
}

export function coroutineFrameShape(
  classes: ClassTable,
  fn: string,
  slots: readonly CoroutineSlot[],
): ClassShape {
  return classes.defineSynthetic(
    syntheticSurface(coroutineFrameName(fn), CORO_FRAME_BASE, [
      [CORO_RESULT_FIELD, coroutinePromiseName(fn)],
      ...slots.map((slot) => [slot.name, slot.declaredType] as const),
    ]),
  );
}
