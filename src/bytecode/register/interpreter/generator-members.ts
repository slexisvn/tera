import {
  getPayload,
  mkFunction,
  mkUndefined,
  type GeneratorValue,
  type TaggedValue,
} from "../../../core/value/index.js";
import { createIteratorResult } from "../../../runtime/iteration/iterator.js";
import {
  GEN_NEWBORN,
  GEN_SUSPENDED,
  GEN_COMPLETED,
} from "../../../runtime/iteration/generator.js";
import { RegisterException, completeGenerator, runGeneratorFrame } from "./helpers.js";
import type { RegisterFrame, ResumeOwner } from "./frame.js";

export type GeneratorMemberInterpreter = {
  runFrame(frame: RegisterFrame): TaggedValue;
  suspendedFrames: Map<RegisterFrame, ResumeOwner>;
};

export function asGeneratorMemberInterpreter(
  interpreter: unknown,
): GeneratorMemberInterpreter | null {
  const candidate = interpreter as GeneratorMemberInterpreter | null | undefined;
  return candidate &&
    typeof candidate.runFrame === "function" &&
    candidate.suspendedFrames instanceof Map
    ? candidate
    : null;
}

export function generatorMemberValue(
  interp: GeneratorMemberInterpreter,
  obj: GeneratorValue,
  propName: string,
): TaggedValue {
  const gen = getPayload(obj);
  if (propName === "next") {
    return mkFunction({
      name: "next",
      call: (args: TaggedValue[]) => {
        if (gen.state === GEN_COMPLETED)
          return createIteratorResult(mkUndefined(), true);
        if (gen.state === GEN_NEWBORN || gen.state === GEN_SUSPENDED) {
          const wasNewborn = gen.state === GEN_NEWBORN;
          if (args.length > 0 && !wasNewborn) gen.frame.acc = args[0];
          return runGeneratorFrame(interp, gen);
        }
        return createIteratorResult(mkUndefined(), true);
      },
      compiled: null,
    });
  } else if (propName === "return") {
    return mkFunction({
      name: "return",
      call: (args: TaggedValue[]) => {
        completeGenerator(interp, gen);
        return createIteratorResult(
          args.length > 0 ? args[0] : mkUndefined(),
          true,
        );
      },
      compiled: null,
    });
  } else if (propName === "throw") {
    return mkFunction({
      name: "Generator.throw",
      call: (args: TaggedValue[]) => {
        const error = (args[0] === undefined ? mkUndefined() : args[0]);
        if (gen.state === GEN_COMPLETED || gen.state === GEN_NEWBORN) {
          completeGenerator(interp, gen);
          throw new RegisterException(error);
        }
        if (
          gen.frame.exceptionHandlers &&
          gen.frame.exceptionHandlers.length > 0
        ) {
          const handler = gen.frame.exceptionHandlers.pop() as { catchPC: number };
          gen.frame.acc = error;
          gen.frame.pc = handler.catchPC;
          return runGeneratorFrame(interp, gen);
        }
        completeGenerator(interp, gen);
        throw new RegisterException(error);
      },
      compiled: null,
    });
  } else {
    return mkUndefined();
  }
}
