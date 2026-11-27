import { expect, test } from "bun:test";
import { EmbedStyle } from "./embed-style.ts";

test("usage bars fill proportionally and show any use", () => {
  expect(EmbedStyle.bar(0, 50)).toBe("▱▱▱▱▱▱▱▱▱▱");
  expect(EmbedStyle.bar(1, 50)).toBe("▰▱▱▱▱▱▱▱▱▱");
  expect(EmbedStyle.bar(31, 50)).toBe("▰▰▰▰▰▰▱▱▱▱");
  expect(EmbedStyle.bar(50, 50)).toBe("▰▰▰▰▰▰▰▰▰▰");
  expect(EmbedStyle.bar(0, 0)).toBe("▱▱▱▱▱▱▱▱▱▱");
});

test("lines keep whole entries within the limit and count the rest", () => {
  expect(EmbedStyle.lines(["a", "b"], 10)).toBe("a\nb");
  const listed = EmbedStyle.lines(["aaaa", "bbbb", "cccc", "dddd"], 20, ", ");
  expect(listed).toBe("aaaa, …and 3 more");
  expect(listed.length).toBeLessThanOrEqual(20);
  const oversized = EmbedStyle.lines(["x".repeat(50), "y"], 20);
  expect(oversized).toEndWith("…\n…and 1 more");
  expect(oversized.length).toBeLessThanOrEqual(20);
});

test("cards carry the tone colour, icon and shared footer", () => {
  expect(EmbedStyle.card({ tone: "error", title: "Failed", description: "" })).toEqual({
    color: 0xed4245, title: "❌ Failed", footer: { text: "7TV Discord Sync" },
  });
  expect(EmbedStyle.card({ tone: "neutral", title: "Cancelled" }).title).toBe("Cancelled");
});
