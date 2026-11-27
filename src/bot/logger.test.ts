import { expect, mock, test } from "bun:test";
import { Logger } from "./logger.ts";

test("Logger writes informational messages without changing them", () => {
  const log = mock((..._args: unknown[]) => {});
  const error = mock((..._args: unknown[]) => {});
  const logger = new Logger({ log, error });

  logger.info("Ready as bot, caught up 2 Servers.");

  expect(log.mock.calls).toEqual([["Ready as bot, caught up 2 Servers."]]);
  expect(error).not.toHaveBeenCalled();
});

test("Logger writes a single failure message with only safe numeric diagnostics", () => {
  const log = mock((..._args: unknown[]) => {});
  const error = mock((..._args: unknown[]) => {});
  const logger = new Logger({ log, error });
  const failure = Object.assign(new Error("token in message", { cause: new Error("token in cause") }), {
    status: 404, code: 10062, url: "/interactions/123/private-token", requestBody: { token: "private-token" },
  });

  logger.error("Startup failed:", failure);
  logger.error("Startup failed:", { status: 403, code: "private-token" });
  logger.error("Startup failed:", { status: Infinity, code: 10062 });
  logger.error("Startup failed:", { status: "private-token", code: Number.MAX_SAFE_INTEGER + 1 });
  logger.error("Startup failed:", "private-token");
  logger.error("Startup failed:", null);

  expect(error.mock.calls).toEqual([
    ["Startup failed: status=404 code=10062"],
    ["Startup failed: status=403"],
    ["Startup failed: code=10062"],
    ["Startup failed:"],
    ["Startup failed:"],
    ["Startup failed:"],
  ]);
  expect(log).not.toHaveBeenCalled();
});
