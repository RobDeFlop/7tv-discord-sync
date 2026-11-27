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
    Logger.write(LogLevel[method], "example operation=logger_test");
    expect(output.mock.calls).toEqual([[expect.stringMatching(new RegExp(
      `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z ${method.toUpperCase()} example operation=logger_test$`,
    ))]]);
  }
});

test("failure diagnostics include only classes and numeric metadata, without evaluating getters", () => {
  const cause = Object.assign(new TypeError("private request"), { status: 503 });
  const error = new Error("private database URL", { cause });
  error.name = "private_token";
  Object.defineProperty(error, "status", { get: () => { throw new Error("getter called"); } });
  expect(Logger.failure(error)).toBe("error=Error cause=TypeError status=503");
  const { proxy, revoke } = Proxy.revocable(error, {});
  revoke();
  expect(Logger.failure(proxy)).toBe("error=unknown reason=inspection_failed");
});

test("the configured threshold is case insensitive and defaults to info", () => {
  const debug = spyOn(console, "debug").mockImplementation(() => {});
  const info = spyOn(console, "info").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  process.env.LOG_LEVEL = "WARN";
  Logger.write(LogLevel.info, "example operation=hidden");
  Logger.write(LogLevel.warn, "example operation=retrying");
  expect(info).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledTimes(1);
  delete process.env.LOG_LEVEL;
  Logger.write(LogLevel.debug, "example operation=hidden");
  Logger.write(LogLevel.info, "example operation=ready");
  expect(debug).not.toHaveBeenCalled();
  expect(info).toHaveBeenCalledTimes(1);
});
