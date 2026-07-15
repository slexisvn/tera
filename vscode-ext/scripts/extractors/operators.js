import { readFileSync } from 'node:fs';

const TWO_CHAR_PATTERN = /\[\s*((?:'[^']{2}'\s*,\s*)+'[^']{2}')\s*\]\.includes\(\s*two\s*\)/;
const THREE_CHAR_PATTERN = /three\s*===\s*'([^']{3})'/;
const ONE_CHAR_PATTERN = /'([^']*)'\.includes\(\s*ch\s*\)/;

export function extractOperators(tokenizerSourcePath) {
  const text = readFileSync(tokenizerSourcePath, 'utf8');

  const threeChar = [];
  const threeMatch = text.match(THREE_CHAR_PATTERN);
  if (threeMatch) threeChar.push(threeMatch[1]);

  const twoChar = [];
  const twoMatch = text.match(TWO_CHAR_PATTERN);
  if (twoMatch) {
    for (const m of twoMatch[1].matchAll(/'([^']{2})'/g)) twoChar.push(m[1]);
  }

  const oneChar = [];
  const oneMatch = text.match(ONE_CHAR_PATTERN);
  if (oneMatch) {
    for (const ch of oneMatch[1]) oneChar.push(ch);
  }

  if (!threeChar.length || !twoChar.length || !oneChar.length) {
    throw new Error('Operator extraction failed — tokenizer.js shape changed; review extractors/operators.js');
  }
  return { threeChar, twoChar, oneChar };
}
