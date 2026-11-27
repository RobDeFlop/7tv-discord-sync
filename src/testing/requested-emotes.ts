import type { SyncCore } from "../core/index.ts";
import type { ServerId, SevenTvEmoteId } from "../domain/index.ts";

export async function prepareRequestedEmote(core: SyncCore, server: ServerId, id: SevenTvEmoteId) {
  const preview = await core.prepareEmoteAdd(server, `https://7tv.app/emotes/${id}`);
  if (!("prepared" in preview)) throw new Error(`Expected an importable preview for ${id}`);
  return preview;
}

export async function addRequestedEmote(core: SyncCore, server: ServerId, id: SevenTvEmoteId, name?: string) {
  const { prepared } = await prepareRequestedEmote(core, server, id);
  return core.addEmote(server, prepared, name);
}
