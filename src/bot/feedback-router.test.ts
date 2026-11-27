import { expect, spyOn, test } from "bun:test";
import type { APIEmbed } from "discord.js";
import type { Change } from "../domain/index.ts";
import { FakeLogChannel } from "../testing/bot-fakes.ts";
import { SyncCore } from "../core/index.ts";
import { FakeDiscord, FakeSevenTv, FakeStore } from "../testing/fakes.ts";
import { FeedbackRouter } from "./feedback-router.ts";

test("a failed Discord request logs the operation and numeric diagnostics, not the request", async () => {
  const store = new FakeStore();
  const state = await store.load("123");
  state.setLogChannel("log");
  await store.save("123", state);
  const channel = new FakeLogChannel();
  const error = Object.assign(new Error("secret in message"), {
    status: 404, code: 10062, url: "/interactions/123/private-token", requestBody: { token: "private-token" },
  });
  spyOn(channel, "send").mockRejectedValue(error);
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const router = new FeedbackRouter(new SyncCore(new FakeSevenTv(), new FakeDiscord(), store), channel);
    const result = { changes: [], feedback: [{ level: "error" as const, text: "Failed" }] };
    await router.deliver("123", result);
    expect(logged.mock.calls[0]).toEqual([expect.stringMatching(/ ERROR feedback_delivery_failed operation=send_log_embed server=123 error=Error status=404 code=10062$/)]);
    spyOn(channel, "send").mockRejectedValue({ code: "private-token", status: "private-token" });
    await router.deliver("123", result);
    expect(logged.mock.calls[1]).toEqual([expect.stringMatching(/ ERROR feedback_delivery_failed operation=send_log_embed server=123 error=object$/)]);
  } finally {
    logged.mockRestore();
  }
});

test("FeedbackRouter keeps all severities visible within the combined embed text limit", async () => {
  const store = new FakeStore();
  const log = new FakeLogChannel();
  const router = new FeedbackRouter(new SyncCore(new FakeSevenTv(), new FakeDiscord(), store), log);
  const server = "server-1";
  const state = await store.load(server);
  state.setLogChannel("log");
  await store.save(server, state);
  const longText = "x".repeat(6000);

  await router.deliver(server, {
    changes: [],
    feedback: [
      { level: "error", text: "Could not finish syncing." },
      { level: "info", text: longText },
      { level: "warning", text: longText },
    ],
  });

  expect(log.sent).toHaveLength(1);
  const [embed] = log.sent[0]!.embeds;
  expect(embed).toMatchObject({ title: "❌ Couldn't complete that", color: 0xed4245 });
  const [error, warning, info] = embed?.description?.split("\n") ?? [];
  expect(error).toBe("❌ Could not finish syncing.");
  expect(warning).toStartWith("⚠️ xxx");
  expect(warning).toEndWith("…");
  expect(info).toStartWith("xxx");
  expect(info).toEndWith("…");
  expect(FeedbackRouterTest.textLength(embed)).toBeLessThanOrEqual(6000);

  await router.deliver(server, { changes: [], feedback: [{ level: "info", text: longText }] });
  expect(log.sent[1]?.embeds[0]?.description?.length).toBeLessThanOrEqual(4096);
  expect(log.sent[1]?.embeds[0]?.description).toEndWith("…");
});

test("a sync card groups changes by kind and fits a large sync within Discord's limits", async () => {
  const store = new FakeStore();
  const log = new FakeLogChannel();
  const router = new FeedbackRouter(new SyncCore(new FakeSevenTv(), new FakeDiscord(), store), log);
  const state = await store.load("server");
  state.setLogChannel("log");
  await store.save("server", state);
  const added = Array.from({ length: 300 }, (_, i): Change => ({
    type: "created", name: `Emote_${i}`, animated: false, sevenTvEmoteId: `e${i}`, tier: "source",
  }));
  const changes: Change[] = [
    ...added,
    { type: "deleted", name: "Old", reason: "removed" },
    { type: "renamed", from: "Pog", to: "Pog~1" },
    { type: "reserved", name: "hand" },
  ];

  await router.deliverUpdate("server", { kind: "finished", result: { changes, feedback: [{ level: "warning", text: "Big was skipped." }] } });

  const [embed] = log.sent[0]?.embeds ?? [];
  expect(embed).toMatchObject({
    color: 0xf0b232,
    title: "⚠️ Sync finished with warnings",
    description: "**303** emoji changes.\n\nBig was skipped.",
    footer: { text: "7TV Discord Sync" },
  });
  expect(embed?.fields?.map(({ name }) => name)).toEqual([
    "➕ Added (300)", "➖ Removed (1)", "📌 Kept as Reserved Slots (1)", "✏️ Renamed (1)",
  ]);
  expect(embed?.fields?.[0]?.value).toStartWith("`Emote_0`, `Emote_1`");
  expect(embed?.fields?.[0]?.value).toMatch(/, …and \d+ more$/);
  expect(embed?.fields?.[3]).toEqual({ name: "✏️ Renamed (1)", value: "`Pog` → `Pog~1`", inline: false });
  expect(FeedbackRouterTest.textLength(embed)).toBeLessThanOrEqual(6000);
});

test("a background sync that changed nothing posts nothing", async () => {
  const store = new FakeStore();
  const log = new FakeLogChannel();
  const router = new FeedbackRouter(new SyncCore(new FakeSevenTv(), new FakeDiscord(), store), log);
  const state = await store.load("server");
  state.setLogChannel("log");
  await store.save("server", state);
  await router.deliverUpdate("server", { kind: "finished", result: { changes: [], feedback: [] } });
  expect(log.sent).toEqual([]);
});

class FeedbackRouterTest {
  public static textLength(embed: APIEmbed | undefined): number {
    const fields = (embed?.fields ?? []).reduce((total, field) => total + field.name.length + field.value.length, 0);
    return (embed?.title?.length ?? 0) + (embed?.description?.length ?? 0) + (embed?.footer?.text.length ?? 0) + fields;
  }
}
