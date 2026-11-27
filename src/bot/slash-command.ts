import type { APIEmbed } from "discord.js";
import type { SyncCore, Command } from "../core/index.ts";
import { DomainError, type ServerId } from "../domain/index.ts";
import { FeedbackRouter } from "./feedback-router.ts";
import { Logger, LogLevel } from "./logger.ts";
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

  public constructor(protected readonly core: SyncCore) {}

  public async handle(request: SlashRequest): Promise<void> {
    const server = request.serverId;
    if (server === null) return request.reply(FeedbackRouter.refusal("This command only works in a Server."));
    if (!request.isAdministrator) return request.reply(FeedbackRouter.refusal("Only members with the Administrator permission can use this command."));
    await request.defer();
    try {
      const reply = await this.run(server, request);
      if (reply !== undefined) await request.reply(reply);
    } catch (err) {
      if (err instanceof DomainError) return request.reply(FeedbackRouter.card([err.toFeedback()]));
      Logger.write(LogLevel.error, `slash_command_failed operation=run_command command=${Logger.field(this.path)} server=${Logger.field(server)} ${Logger.failure(err)}`);
      await request.reply(FeedbackRouter.refusal("Something went wrong. Try again in a moment."));
    }
  }

  /** Do the work and return the ephemeral reply. */
  protected abstract run(server: ServerId, request: SlashRequest): Promise<SlashReply | void>;

  protected async apply(server: ServerId, command: Command): Promise<APIEmbed> {
    return FeedbackRouter.card((await this.core.apply(server, command)).feedback);
  }

  protected requiredString(request: SlashRequest, name: string): string {
    const value = request.stringOption(name);
    if (value === null) throw new Error(`Missing option ${name}`);
    return value;
  }
}
