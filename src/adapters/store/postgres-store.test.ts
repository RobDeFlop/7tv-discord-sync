import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyServerState, type ServerState } from "../../domain/index.ts";
import { createPostgresStore, type PostgresStore } from "./postgres-store.ts";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("PostgresStore (needs DATABASE_URL)", () => {
  let store: PostgresStore;
  const a = "test-server-a";
  const b = "test-server-b";

  beforeAll(async () => {
    store = createPostgresStore(url!);
    await store.migrate();
    await store.remove(a);
    await store.remove(b);
  });
  afterAll(async () => {
    await store.remove(a);
    await store.remove(b);
    await store.close();
  });

  const sample: ServerState = {
    managedEmotes: [{ discordEmojiId: "1", sevenTvEmoteId: "e1", tier: "source", quota: "static" }],
    reservedSlots: [{ discordEmojiId: "2", quota: "animated" }],
    requestedEmotes: [{ sevenTvEmoteId: "e2", requestedName: "pog" }],
    linkedUserId: "u1",
    trending: { enabled: true, period: "month" },
    logChannelId: "c1",
    problems: [{ kind: "too-large", message: "big", sevenTvEmoteId: "e3" }],
  };

  test("unknown server loads empty state", async () => {
    expect(await store.load(a)).toEqual(emptyServerState());
  });

  test("save then load round-trips, and save overwrites", async () => {
    await store.save(a, sample);
    expect(await store.load(a)).toEqual(sample);
    await store.save(a, emptyServerState());
    expect(await store.load(a)).toEqual(emptyServerState());
  });

  test("state is scoped per server; remove deletes only that server", async () => {
    await store.save(a, sample);
    await store.save(b, emptyServerState());
    expect(await store.listServers()).toEqual(expect.arrayContaining([a, b]));
    await store.remove(a);
    expect(await store.load(a)).toEqual(emptyServerState());
    expect(await store.listServers()).not.toContain(a);
    expect(await store.listServers()).toContain(b);
  });

  test("fields added to ServerState later survive a round trip", async () => {
    const extended = { ...sample, futureField: { x: 1 } } as ServerState;
    await store.save(a, extended);
    expect(await store.load(a)).toEqual(extended);
  });
});
