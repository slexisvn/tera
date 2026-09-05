export const POWER_STEPS: readonly number[] = [512, 256, 128, 64, 32, 16, 8, 4, 2, 1];

export function float(value: number): string {
  const spelled = String(value).replace("e+", "e");
  return spelled.includes(".") || spelled.includes("e") ? spelled : `${spelled}.0`;
}
