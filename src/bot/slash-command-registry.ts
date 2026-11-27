import {
  ApplicationCommandOptionType,
  ChannelType,
  PermissionFlagsBits,
  type APIApplicationCommandBasicOption,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
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

/** Knows every slash command: builds what is registered with Discord and routes a request to its command. */
export class SlashCommandRegistry {
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
  public definitions(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
    const byName = new Map<string, RESTPostAPIChatInputApplicationCommandsJSONBody>();
    for (const command of this.commands.values()) {
      const [name, sub] = command.path.split(" ");
      if (!name) throw new Error("Slash command path is empty");
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

  private static optionsOf(command: SlashCommand): APIApplicationCommandBasicOption[] {
    return command.options.map((o) => SlashCommandRegistry.option(o));
  }

  private static option(o: SlashOption): APIApplicationCommandBasicOption {
    const base = { name: o.name, description: o.description, required: o.required ?? false };
    switch (o.type) {
      case "string": return { ...base, type: ApplicationCommandOptionType.String, choices: o.choices?.map((c) => ({ name: c, value: c })) };
      case "boolean": return { ...base, type: ApplicationCommandOptionType.Boolean };
      case "channel": return { ...base, type: ApplicationCommandOptionType.Channel, channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement] };
    }
  }
}
