import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Logger, LogLevel } from "./logger.ts";

const initialLevel = process.env.LOG_LEVEL;
afterEach(() => {
  mock.restore();
  if (initialLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = initialLevel;
});

test("the minimum level filters output before it reaches the console", () => {
  const debug = spyOn(console, "debug").mockImplementation(() => {});
  const info = spyOn(console, "info").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  process.env.LOG_LEVEL = "warn";
  Logger.write(LogLevel.debug, "hidden");
  Logger.write(LogLevel.info, "hidden");
  Logger.write(LogLevel.warn, "retrying");
  expect(debug).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
  expect(warn.mock.calls).toEqual([[expect.stringMatching(/^\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\]\[warn\]: retrying$/)]]);
  delete process.env.LOG_LEVEL;
  Logger.write(LogLevel.debug, "still hidden");
  Logger.write(LogLevel.info, "ready");
  expect(debug).not.toHaveBeenCalled();
  expect(info).toHaveBeenCalledTimes(1);
});

test("external objects and thrown values never expose raw request data", () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  const failure = Object.assign(new Error("private-token"), {
    status: 404, code: 10062, requestBody: { token: "private-token" },
  });
  Logger.write(LogLevel.error, failure);
  Logger.write(LogLevel.error, "Startup failed:", failure, "private-token");
  Logger.write(LogLevel.error, "Startup failed:", { status: Infinity, code: "private-token" }, null);
  expect(error.mock.calls).toEqual([
    [expect.stringMatching(/^\[[\dT:Z.\-]+\]\[error\]: status=404 code=10062$/)],
    [expect.stringMatching(/^\[[\dT:Z.\-]+\]\[error\]: Startup failed: status=404 code=10062$/)],
    [expect.stringMatching(/^\[[\dT:Z.\-]+\]\[error\]: Startup failed:$/)],
  ]);
});
