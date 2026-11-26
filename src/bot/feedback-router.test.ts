import { expect, test } from "bun:test";
import { FakeLogChannel } from "../testing/bot-fakes.ts";
import { FakeStore } from "../testing/fakes.ts";
import { FeedbackRouter } from "./feedback-router.ts";

test("FeedbackRouter keeps all severities visible within the combined embed text limit", async () => {
  const store = new FakeStore();
  const log = new FakeLogChannel();
  const router = new FeedbackRouter(store, log);
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
  const embeds = log.sent[0]!.embeds;
  expect(embeds.map((embed) => embed.title)).toEqual(["Sync results", "Sync warnings", "Sync errors"]);
  expect(embeds[0]?.description).toEndWith("…");
  expect(embeds[1]?.description).toEndWith("…");
  expect(embeds[2]?.description).toBe("Could not finish syncing.");
  expect(embeds.reduce((total, embed) => total + (embed.title?.length ?? 0) + (embed.description?.length ?? 0), 0))
    .toBeLessThanOrEqual(6000);

  await router.deliver(server, { changes: [], feedback: [{ level: "info", text: longText }] });
  expect(log.sent[1]?.embeds[0]?.description).toHaveLength(4096);
});
