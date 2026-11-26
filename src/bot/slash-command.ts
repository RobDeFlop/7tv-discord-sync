import type { SyncCore, Command } from "../core/index.ts";
import type { ServerId } from "../domain/index.ts";
import { FeedbackRouter } from "./feedback-router.ts";
import type { ServerLock } from "./server-lock.ts";
import type { SlashRequest } from "./slash-request.ts";

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

  public constructor(
    protected readonly core: SyncCore,
    private readonly lock: ServerLock,
  ) {}

  public async handle(request: SlashRequest): Promise<void> {
    const server = request.serverId;
    if (server === null) return request.reply("This command only works in a Server.");
    if (!request.isAdministrator) return request.reply("Only members with the Administrator permission can use this command.");
    await request.defer();
    try {
      await request.reply(await this.lock.run(server, () => this.run(server, request)));
    } catch (err) {
      console.error(`/${this.path} failed in ${server}:`, err);
      await request.reply("Something went wrong. Try again in a moment.");
    }
  }

  /** Do the work and return the reply text. */
  protected abstract run(server: ServerId, request: SlashRequest): Promise<string>;

  protected async apply(server: ServerId, command: Command): Promise<string> {
    return FeedbackRouter.format((await this.core.apply(server, command)).feedback);
  }

  protected requiredString(request: SlashRequest, name: string): string {
    const value = request.stringOption(name);
    if (value === null) throw new Error(`Missing option ${name}`);
    return value;
  }
}
