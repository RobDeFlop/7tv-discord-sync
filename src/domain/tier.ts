/** Who a slot is held for, see Precedence in GLOSSARY.md (the order itself lives on SlotOccupant). */
export type Tier = "reserved" | "requested" | "source" | "trending";

/** Managed Emotes can only hold the tiers the bot grants itself. */
export type ManagedTier = Exclude<Tier, "reserved">;
