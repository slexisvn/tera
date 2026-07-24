export const PALETTE = ['#6d8dff', '#e06c75', '#2aa876', '#d9902f', '#8b5cf6', '#0891b2', '#db4b9f', '#64748b'];

export function colorAt(index: number): string {
  return PALETTE[Math.abs(index) % PALETTE.length];
}
