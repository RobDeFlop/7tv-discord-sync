/** Static and animated emojis have separate quotas. */
export type Quota = "static" | "animated";

/** Value object: how many emojis per Quota a Server may hold at its boost level. */
export class ServerQuotas {
  public static readonly ALL: ReadonlyArray<Quota> = ["static", "animated"];

  /** Discord's emoji slots per quota by boost level (0 to 3). */
  private static readonly SLOTS_BY_BOOST_LEVEL: ReadonlyArray<number> = [50, 100, 150, 250];

  public constructor(public readonly boostLevel: number) {}

  /** The quota an emoji of this kind counts against. */
  public static quotaOf(animated: boolean): Quota {
    return animated ? "animated" : "static";
  }

  /** Slots in each quota: Discord gives static and animated emojis the same number at every boost level. */
  public limit(): number {
    const levels = ServerQuotas.SLOTS_BY_BOOST_LEVEL;
    const level = Math.min(Math.max(this.boostLevel, 0), levels.length - 1);
    return levels[level] ?? 0;
  }
}
