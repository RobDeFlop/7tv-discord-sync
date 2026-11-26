import type { ServerId } from "../domain/index.ts";

/** One invocation of a slash command, as far as the bot's command handlers need to see it. */
export abstract class SlashRequest {
  /** Full command path, e.g. "emote add" or "sync". */
  public abstract get commandPath(): string;
  /** The Server it was used in, or null in a direct message. */
  public abstract get serverId(): ServerId | null;
  public abstract get isAdministrator(): boolean;
  /** Value of a string option (also channel and choice options, as ids/values), or null if not given. */
  public abstract stringOption(name: string): string | null;
  public abstract booleanOption(name: string): boolean | null;
  /** Acknowledge now; the real reply follows once the work is done. Replies are always ephemeral. */
  public abstract defer(): Promise<void>;
  public abstract reply(text: string): Promise<void>;
}
