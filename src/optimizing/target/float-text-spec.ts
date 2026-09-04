import {
  CHAR_DECIMAL_POINT,
  CHAR_DIGIT_ZERO,
  CHAR_EXPONENT_MARK,
  CHAR_MINUS_SIGN,
  CHAR_PLUS_SIGN,
  CHAR_TERMINATOR,
  DECIMAL_RADIX,
  INFINITY_TEXT,
  NEGATIVE_INFINITY_TEXT,
  NOT_A_NUMBER_TEXT,
} from "./text.js";
import { ABSENCE_VALUES, NULL_TEXT, UNDEFINED_TEXT } from "../metadata/printed-values.js";

export {
  ABSENCE_VALUES,
  INFINITY_TEXT,
  NEGATIVE_INFINITY_TEXT,
  NOT_A_NUMBER_TEXT,
  NULL_TEXT,
  UNDEFINED_TEXT,
};

export const RADIX = DECIMAL_RADIX;
export const DIGIT_ZERO = CHAR_DIGIT_ZERO;
export const MINUS_SIGN = CHAR_MINUS_SIGN;
export const PLUS_SIGN = CHAR_PLUS_SIGN;
export const DECIMAL_POINT = CHAR_DECIMAL_POINT;
export const EXPONENT_MARK = CHAR_EXPONENT_MARK;
export const TERMINATOR = CHAR_TERMINATOR;

export const NEGATIVE_FLAG = 1;
export const INCLUSIVE_FLAG = 2;
export const LOW_FLAG = 4;
export const HIGH_FLAG = 8;
export const ALL_FLAGS = 0xffffffff;

export const BIGNUM_NAMES = [
  "remainder",
  "divisor",
  "above",
  "below",
  "scratch",
] as const;
export type BignumName = (typeof BIGNUM_NAMES)[number];

export const STATE_REMAINDER_SHIFT = 0;
export const STATE_DIVISOR_SHIFT = 4;
export const STATE_POSITIVE_EXPONENT = 8;
export const STATE_STEP = 12;
export const STATE_DESTINATION = 16;
export const STATE_BYTES = 24;

export interface FloatTextKeys {
  readonly state: string;
  readonly digits: string;
  readonly exponent: string;
  readonly notANumber: string;
  readonly infinity: string;
  readonly negativeInfinity: string;
  bignum(name: BignumName): string;
  ofText(text: string): string;
}

export function floatTextKeys(prefix: string): FloatTextKeys {
  const key = (suffix: string) => `${prefix}:float-${suffix}`;
  const notANumber = key("nan");
  const infinity = key("infinity");
  const negativeInfinity = key("negative-infinity");
  const byText = new Map([
    [NOT_A_NUMBER_TEXT, notANumber],
    [INFINITY_TEXT, infinity],
    [NEGATIVE_INFINITY_TEXT, negativeInfinity],
    ...ABSENCE_VALUES.map((absence) => [absence.text, key(`absent-${absence.text}`)] as const),
  ]);
  return {
    state: key("state"),
    digits: key("digits"),
    exponent: key("exponent"),
    notANumber,
    infinity,
    negativeInfinity,
    bignum: (name) => key(name),
    ofText: (text) => {
      const found = byText.get(text);
      if (found === undefined) throw new Error(`no float text key for ${text}`);
      return found;
    },
  };
}
