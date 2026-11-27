import { ApplicationCommandOptionType, PermissionFlagsBits } from "discord.js";
import type { SyncCore } from "../core/index.ts";
import { ConfigLogChannelSlashCommand } from "./commands/config-log-channel-slash-command.ts";
import { EmoteAddSlashCommand } from "./commands/emote-add-slash-command.ts";
import { EmoteRemoveSlashCommand } from "./commands/emote-remove-slash-command.ts";
import { SearchSlashCommand } from "./commands/search-slash-command.ts";
import { EmoteAddPreviews } from "./emote-add-previews.ts";
import { SetLinkSlashCommand } from "./commands/set-link-slash-command.ts";
import { SetUnlinkSlashCommand } from "./commands/set-unlink-slash-command.ts";
import { StatusSlashCommand } from "./commands/status-slash-command.ts";
import { SyncSlashCommand } from "./commands/sync-slash-command.ts";
import { TrendingSlashCommand } from "./commands/trending-slash-command.ts";
import type { EmoteAddInteraction } from "./emote-add-interaction.ts";
import type { FeedbackRouter, LogChannel } from "./feedback-router.ts";
import type { SlashCommand, SlashOption } from "./slash-command.ts";
import type { SlashRequest } from "./slash-request.ts";

export interface CommandDefinition {
  name: string;
  description: string;
  default_member_permissions: string;
  dm_permission: boolean;
  options?: OptionDefinition[];
}

export interface OptionDefinition {
  name: string;
  description: string;
  type: number;
  required?: boolean;
  choices?: { name: string; value: string }[];
  channel_types?: number[];
  options?: OptionDefinition[];
}

/** Knows every slash command: builds what is registered with Discord and routes a request to its command. */
export class SlashCommandRegistry {
  private static readonly TEXT_CHANNEL = 0;
  private static readonly ANNOUNCEMENT_CHANNEL = 5;

  private readonly commands: ReadonlyMap<string, SlashCommand>;
  private readonly previews: EmoteAddPreviews;

  public constructor(core: SyncCore, feedback: FeedbackRouter, logChannel: LogChannel) {
    this.previews = new EmoteAddPreviews(core);
    const all: SlashCommand[] = [
      new EmoteAddSlashCommand(core, this.previews),
      new SearchSlashCommand(core, this.previews),
      new EmoteRemoveSlashCommand(core),
      new SetLinkSlashCommand(core, feedback),
      new SetUnlinkSlashCommand(core),
      new TrendingSlashCommand(core, feedback),
      new SyncSlashCommand(core, feedback),
      new StatusSlashCommand(core, logChannel),
      new ConfigLogChannelSlashCommand(core),
    ];
    this.commands = new Map(all.map((c) => [c.path, c]));
  }

  public async handle(request: SlashRequest): Promise<void> {
    const command = this.commands.get(request.commandPath);
    if (!command) return request.reply("Unknown command.");
    return command.handle(request);
  }

  public async handleEmoteAddInteraction(request: EmoteAddInteraction): Promise<void> {
    return this.previews.handleInteraction(request);
  }

  /** Command definitions for Discord: "emote add" becomes subcommand `add` of `/emote`. Administrators only. */
  public definitions(): CommandDefinition[] {
    const byName = new Map<string, CommandDefinition>();
    for (const command of this.commands.values()) {
      const [name, sub] = command.path.split(" ") as [string, string | undefined];
      let def = byName.get(name);
      if (!def) {
        def = {
          name,
          description: sub ? `${name} commands` : command.description,
          default_member_permissions: PermissionFlagsBits.Administrator.toString(),
          dm_permission: false,
        };
        byName.set(name, def);
      }
      if (sub) {
        def.options = [
          ...(def.options ?? []),
          {
            name: sub,
            description: command.description,
            type: ApplicationCommandOptionType.Subcommand,
            options: SlashCommandRegistry.optionsOf(command),
          },
        ];
      } else {
        def.options = SlashCommandRegistry.optionsOf(command);
      }
    }
    return [...byName.values()];
  }

  private static optionsOf(command: SlashCommand): OptionDefinition[] {
    return command.options.map((o) => SlashCommandRegistry.option(o));
  }

  private static option(o: SlashOption): OptionDefinition {
    const types = {
      string: ApplicationCommandOptionType.String,
      boolean: ApplicationCommandOptionType.Boolean,
      channel: ApplicationCommandOptionType.Channel,
    };
    return {
      name: o.name,
      description: o.description,
      type: types[o.type],
      required: o.required ?? false,
      ...(o.choices ? { choices: o.choices.map((c) => ({ name: c, value: c })) } : {}),
      ...(o.type === "channel"
        ? { channel_types: [SlashCommandRegistry.TEXT_CHANNEL, SlashCommandRegistry.ANNOUNCEMENT_CHANNEL] }
        : {}),
    };
  }
}
