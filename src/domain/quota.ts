/** Static and animated emojis have separate quotas. */
export type Quota = "static" | "animated";

/** Value object: how many emojis per Quota a Server may hold at its boost level. */
export class ServerQuotas {
  public static readonly ALL: ReadonlyArray<Quota> = ["static", "animated"];

  /** Discord's emoji slots per quota by boost level (0 to 3). */
  private static readonly SLOTS_BY_BOOST_LEVEL = [50, 100, 150, 250] as const;

  public constructor(public readonly boostLevel: number) {}

  /** The quota an emoji of this kind counts against. */
  public static quotaOf(animated: boolean): Quota {
    return animated ? "animated" : "static";
  }

  public limit(_quota: Quota): number {
    const level = Math.min(Math.max(this.boostLevel, 0), ServerQuotas.SLOTS_BY_BOOST_LEVEL.length - 1);
    return ServerQuotas.SLOTS_BY_BOOST_LEVEL[level]!;
  }
}
