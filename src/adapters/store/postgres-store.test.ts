import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ServerState, type ServerStateSnapshot } from "../../domain/index.ts";
import { PostgresStore } from "./postgres-store.ts";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PostgresStore (needs TEST_DATABASE_URL)", () => {
  let store: PostgresStore;
  const a = "test-server-a";
  const b = "test-server-b";
  const empty = ServerState.empty().toSnapshot();

  beforeAll(async () => {
    if (!url) throw new Error("TEST_DATABASE_URL must point to a disposable database");
    store = new PostgresStore(url);
    await store.migrate();
    await store.remove(a);
    await store.remove(b);
  });
  afterAll(async () => {
    await store.remove(a);
    await store.remove(b);
    await store.close();
  });

  const sample: ServerStateSnapshot = {
    managedEmotes: [{ discordEmojiId: "1", sevenTvEmoteId: "e1", tier: "source", quota: "static" }],
    reservedSlots: [{ discordEmojiId: "2", quota: "animated" }],
    requestedEmotes: [{ sevenTvEmoteId: "e2", requestedName: "pog" }],
    linkedUserId: "u1",
    trending: { enabled: true, period: "month" },
    logChannelId: "c1",
    problems: [{ kind: "too-large", message: "big", sevenTvEmoteId: "e3" }],
  };

  const snapshotOf = async (server: string) => (await store.load(server)).toSnapshot();

  test("unknown server loads empty state", async () => {
    expect(await snapshotOf(a)).toEqual(empty);
  });

  test("save then load round-trips, and save overwrites", async () => {
    await store.save(a, ServerState.fromSnapshot(sample));
    expect(await snapshotOf(a)).toEqual(sample);
    await store.save(a, ServerState.empty());
    expect(await snapshotOf(a)).toEqual(empty);
  });

  test("state is scoped per server; remove deletes only that server", async () => {
    await store.save(a, ServerState.fromSnapshot(sample));
    await store.save(b, ServerState.empty());
    expect(await store.listServers()).toEqual(expect.arrayContaining([a, b]));
    await store.remove(a);
    expect(await snapshotOf(a)).toEqual(empty);
    expect(await store.listServers()).not.toContain(a);
    expect(await store.listServers()).toContain(b);
  });

  test("fields added to the snapshot later survive a round trip", async () => {
    const extended: ServerStateSnapshot = { ...sample, extra: { futureField: { x: 1 } } };
    await store.save(a, ServerState.fromSnapshot(extended));
    expect(await snapshotOf(a)).toEqual(extended);
  });
});
