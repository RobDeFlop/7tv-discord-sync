import { FailureLog } from "./failure-log.ts";
import type { SyncCore, Command } from "../core/index.ts";
import { DomainError, type ServerId } from "../domain/index.ts";
import { FeedbackRouter } from "./feedback-router.ts";
import type { ServerLock } from "./server-lock.ts";
import type { SlashReply, SlashRequest } from "./slash-request.ts";

export interface SlashOption {
  name: string;
  description: string;
  type: "string" | "boolean" | "channel";
  required?: boolean;
  choices?: ReadonlyArray<string>;
}

/**
 * A slash command. The base class makes sure only administrators in a Server run it and that
 * every answer is ephemeral; subclasses translate the request into a core call.
 */
export abstract class SlashCommand {
  /** Command path: "sync", or "emote add" for a subcommand. */
  public abstract readonly path: string;
  public abstract readonly description: string;
  public readonly options: ReadonlyArray<SlashOption> = [];

  protected readonly needsLock: boolean = true;

  public constructor(
    protected readonly core: SyncCore,
    protected readonly lock: ServerLock,
  ) {}

  public async handle(request: SlashRequest): Promise<void> {
    const server = request.serverId;
    if (server === null) return request.reply("This command only works in a Server.");
    if (!request.isAdministrator) return request.reply("Only members with the Administrator permission can use this command.");
    await request.defer();
    try {
      const run = () => this.run(server, request);
      await request.reply(await (this.needsLock ? this.lock.run(server, run) : run()));
    } catch (err) {
      if (err instanceof DomainError) return request.reply(FeedbackRouter.format([err.toFeedback()]));
      new FailureLog(err).write(`/${this.path} failed in ${server}:`);
      await request.reply("Something went wrong. Try again in a moment.");
    }
  }

  /** Do the work and return the ephemeral reply. */
  protected abstract run(server: ServerId, request: SlashRequest): Promise<SlashReply>;

  protected async apply(server: ServerId, command: Command): Promise<string> {
    return FeedbackRouter.format((await this.core.apply(server, command)).feedback);
  }

  protected requiredString(request: SlashRequest, name: string): string {
    const value = request.stringOption(name);
    if (value === null) throw new Error(`Missing option ${name}`);
    return value;
  }
}
