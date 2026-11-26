# 7TV Discord Sync

Keeps a Discord server's emojis continuously in sync with emotes from 7TV. Sync is one-way: 7TV → Discord.

## Language

**Server**:
A Discord server (guild) the bot is installed on. All data is scoped per server.
_Avoid_: Guild, Tenant

**Slot**:
One place in a server's emoji quota. Static and animated emojis have separate quotas.

**Managed Emote**:
A Discord emoji created by the bot and linked to a 7TV emote. The bot only ever changes or removes Managed Emotes.
_Avoid_: Synced emoji, bot emoji

**Reserved Slot**:
A slot occupied by an emoji the bot did not create. The bot tracks it but never modifies it.
_Avoid_: Foreign emoji, manual emoji

**Source Set**:
The currently active 7TV emote set of a linked 7TV user, mirrored to a server. Follows the user when they switch sets. Optional.
_Avoid_: Emote set, channel set

**Requested Emote**:
A 7TV emote a user explicitly added to a server via command, independent of the Source Set. Stays even if it leaves the Source Set.
_Avoid_: Manual emote, custom emote, single emote

**Trending Fill**:
Popular 7TV emotes that occupy the remaining free slots. Opt-in.
_Avoid_: Popular, auto-fill

**Precedence**:
The order in which slots are granted: Reserved Slots, then Requested Emotes, then Source Set, then Trending Fill. What a user explicitly asks for beats automation.

**Displacement**:
A Managed Emote losing its slot to an emote of higher Precedence, within the same quota (static or animated). Reserved Slots are never displaced.
_Avoid_: Eviction, replacement
