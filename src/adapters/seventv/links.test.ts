import { expect, test } from "bun:test";
import { parseSevenTvLink } from "./links.ts";

const ID = "01F6MQ33FG000FFJ97ZB8MWV52";

test("parses emote, user and set links", () => {
  expect(parseSevenTvLink(`https://7tv.app/emotes/${ID}`)).toEqual({ kind: "emote", id: ID });
  expect(parseSevenTvLink(`https://7tv.app/users/${ID}`)).toEqual({ kind: "user", id: ID });
  expect(parseSevenTvLink(`https://7tv.app/emote-sets/${ID}`)).toEqual({ kind: "set", id: ID });
});

test("accepts legacy host, query strings and surrounding whitespace", () => {
  expect(parseSevenTvLink(` https://old.7tv.app/emotes/${ID}?x=1 `)).toEqual({ kind: "emote", id: ID });
});

test("accepts a bare id with unknown kind", () => {
  expect(parseSevenTvLink(ID)).toEqual({ kind: "unknown", id: ID });
});

test("rejects other hosts, paths and garbage", () => {
  expect(parseSevenTvLink(`https://example.com/emotes/${ID}`)).toBeNull();
  expect(parseSevenTvLink(`https://7tv.app/emotes/short`)).toBeNull();
  expect(parseSevenTvLink(`https://7tv.app/store/${ID}`)).toBeNull();
  expect(parseSevenTvLink("hello")).toBeNull();
});
