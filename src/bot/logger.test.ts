import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Logger, LogLevel } from "./logger.ts";

const initialLevel = process.env.LOG_LEVEL;
afterEach(() => {
  mock.restore();
  if (initialLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = initialLevel;
});

test("write sends one timestamped message to the matching console method", () => {
  process.env.LOG_LEVEL = "debug";
  for (const method of ["debug", "info", "warn", "error"] as const) {
    const output = spyOn(console, method).mockImplementation(() => {});
    Logger.write(LogLevel[method], "two words");
    expect(output.mock.calls).toEqual([[expect.stringMatching(new RegExp(
      `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z ${method.toUpperCase()} two words$`,
    ))]]);
  }
});

test("the configured threshold is case insensitive and defaults to info", () => {
  const debug = spyOn(console, "debug").mockImplementation(() => {});
  const info = spyOn(console, "info").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  process.env.LOG_LEVEL = "WARN";
  Logger.write(LogLevel.info, "hidden");
  Logger.write(LogLevel.warn, "retrying");
  expect(info).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledTimes(1);
  delete process.env.LOG_LEVEL;
  Logger.write(LogLevel.debug, "hidden");
  Logger.write(LogLevel.info, "ready");
  expect(debug).not.toHaveBeenCalled();
  expect(info).toHaveBeenCalledTimes(1);
});
