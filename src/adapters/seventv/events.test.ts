import { expect, test } from "bun:test";
import type { SevenTvChange } from "../../ports/index.ts";
import { SevenTvAdapter } from "./adapter.ts";
import { EventSocket } from "./events.ts";
import { SevenTvFixtures as fx } from "./fixtures.ts";
import { FakeImagePipeline } from "../../testing/fakes.ts";

class FakeSocket extends EventSocket {
  public sent: any[] = [];
  public closed = false;
  public send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  public close() {
    this.closed = true;
  }
  public receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const hello = { op: 1, d: { heartbeat_interval: 45000, session_id: "s" } };

function setup() {
  const sets = new Map<string, unknown>([[fx.SET_ID, structuredClone(fx.emoteSet)]]);
  const users = new Map<string, unknown>([[fx.USER_ID, structuredClone(fx.user)]]);
  const fetchFn = (async (u: string) => {
    const m = /\/(emote-sets|users)\/(\w+)$/.exec(u);
    const hit = m && (m[1] === "users" ? users : sets).get(m[2]!);
    return hit ? Response.json(hit) : new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const sockets: FakeSocket[] = [];
  const adapter = new SevenTvAdapter(new FakeImagePipeline({ ok: false, reason: "unavailable" }), {
    fetch: fetchFn,
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    pollIntervalMs: 0,
  });
  const changes: SevenTvChange[] = [];
  return { adapter, sets, users, sockets, changes, listen: () => adapter.subscribe((c) => changes.push(c)) };
}

test("subscribes to watched set and user over the EventAPI after hello", async () => {
  const t = setup();
  await t.adapter.getSet(fx.SET_ID);
  await t.adapter.getUser(fx.USER_ID);
  t.listen();
  t.sockets[0]!.receive(hello);
  expect(t.sockets[0]!.sent).toContainEqual({
    op: 35,
    d: { type: "emote_set.update", condition: { object_id: fx.SET_ID } },
  });
  expect(t.sockets[0]!.sent).toContainEqual({
    op: 35,
    d: { type: "user.update", condition: { object_id: fx.USER_ID } },
  });
});

test("a set update dispatch emits set-changed", async () => {
  const t = setup();
  await t.adapter.getSet(fx.SET_ID);
  t.listen();
  t.sockets[0]!.receive(hello);
  t.sockets[0]!.receive({
    op: 0,
    d: { type: "emote_set.update", body: { id: fx.SET_ID, pushed: [{ key: "emotes", index: 3 }] } },
  });
  expect(t.changes).toEqual([{ type: "set-changed", setId: fx.SET_ID }]);
});

test("a user connections update emits active-set-switched; unrelated user updates do not", async () => {
  const t = setup();
  await t.adapter.getUser(fx.USER_ID);
  t.listen();
  t.sockets[0]!.receive(hello);
  t.sockets[0]!.receive({ op: 0, d: { type: "user.update", body: { id: fx.USER_ID, updated: [{ key: "avatar_url" }] } } });
  expect(t.changes).toEqual([]);
  t.sockets[0]!.receive({
    op: 0,
    d: { type: "user.update", body: { id: fx.USER_ID, updated: [{ key: "connections", nested: true }] } },
  });
  expect(t.changes).toEqual([{ type: "active-set-switched", userId: fx.USER_ID }]);
});

test("watching a set after connect subscribes immediately", async () => {
  const t = setup();
  t.listen();
  t.sockets[0]!.receive(hello);
  await t.adapter.getSet(fx.SET_ID);
  expect(t.sockets[0]!.sent).toHaveLength(1);
});

test("reconnects after a drop and resubscribes", async () => {
  const t = setup();
  await t.adapter.getSet(fx.SET_ID);
  t.listen();
  t.sockets[0]!.receive(hello);
  t.sockets[0]!.onclose?.({ code: 4000 });
  await Bun.sleep(1500 + 50);
  expect(t.sockets).toHaveLength(2);
  t.sockets[1]!.receive(hello);
  expect(t.sockets[1]!.sent).toHaveLength(1);
});

test("does not reconnect after the last listener leaves", async () => {
  const t = setup();
  const off = t.listen();
  off();
  expect(t.sockets[0]!.closed).toBe(true);
});

test("polling emits set-changed when contents or aliases differ, once", async () => {
  const t = setup();
  await t.adapter.getSet(fx.SET_ID);
  t.listen();
  await t.adapter.pollOnce();
  expect(t.changes).toEqual([]);
  (t.sets.get(fx.SET_ID) as any).emotes[0].name = "renamed";
  await t.adapter.pollOnce();
  await t.adapter.pollOnce();
  expect(t.changes).toEqual([{ type: "set-changed", setId: fx.SET_ID }]);
});

test("polling emits active-set-switched when the user's active set changes", async () => {
  const t = setup();
  await t.adapter.getUser(fx.USER_ID);
  t.listen();
  (t.users.get(fx.USER_ID) as any).connections[1].emote_set_id = "01OTHERSETAAAAAAAAAAAAAAAA";
  await t.adapter.pollOnce();
  expect(t.changes).toEqual([{ type: "active-set-switched", userId: fx.USER_ID }]);
});

test("an event does not make the next poll report the same change again", async () => {
  const t = setup();
  await t.adapter.getSet(fx.SET_ID);
  t.listen();
  t.sockets[0]!.receive(hello);
  (t.sets.get(fx.SET_ID) as any).emotes.pop();
  t.sockets[0]!.receive({ op: 0, d: { type: "emote_set.update", body: { id: fx.SET_ID } } });
  await t.adapter.pollOnce();
  expect(t.changes).toHaveLength(1);
});
