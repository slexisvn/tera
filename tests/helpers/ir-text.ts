export {
  afterPass,
  afterNamedPass,
  analysesFor,
  middleEndPassNames,
  passByName,
  UnknownPassError,
} from "../../src/optimizing/drivers/text-driver.js";
export type { IRTransform } from "../../src/optimizing/drivers/text-driver.js";

export function valuesIn(text: string): readonly string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("v"))
    .map((line) => line.slice(0, line.indexOf(" ")));
}
