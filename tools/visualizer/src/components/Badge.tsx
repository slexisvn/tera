export type BadgeCount = {
  readonly count: number;
  readonly tone: "info" | "bad";
};

export type Badges = Readonly<Record<string, BadgeCount>>;

export function Badge({ badge }: { badge: BadgeCount | undefined }) {
  if (badge === undefined || badge.count === 0) return null;
  return <span className={`badge tone-${badge.tone}`}>{badge.count}</span>;
}
