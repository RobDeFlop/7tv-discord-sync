import { expect, test } from "bun:test";
import { FakeLogChannel } from "./bot-fakes.ts";

test("FakeLogChannel snapshots sent embeds and returns independent copies", async () => {
  const log = new FakeLogChannel();
  const embed = { title: "Sync results", footer: { text: "Recorded" } };
  const embeds = [embed];
  await log.send("log", embeds);

  embed.title = "Changed input";
  embed.footer.text = "Changed input footer";
  embeds.pop();
  const expected = [{ channelId: "log", embeds: [{ title: "Sync results", footer: { text: "Recorded" } }] }];
  const sent = log.sent;
  expect(sent).toEqual(expected);

  sent[0]!.embeds[0]!.footer!.text = "Changed returned footer";
  expect(log.sent).toEqual(expected);
});
