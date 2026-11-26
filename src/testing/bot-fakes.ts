import type { APIEmbed } from "discord.js";
import type { ServerId } from "../domain/index.ts";
import { LogChannel } from "../bot/feedback-router.ts";
import { ServerDirectory } from "../bot/gateway-events.ts";

type SentLogMessage = { channelId: string; embeds: ReadonlyArray<APIEmbed> };

export class FakeLogChannel extends LogChannel {
  private readonly sentHistory: SentLogMessage[] = [];
  public fail = false;

  public get sent(): ReadonlyArray<SentLogMessage> {
    return structuredClone(this.sentHistory);
  }

  public async hasEmbedLinks(_channelId: string): Promise<boolean> {
    return true;
  }

  public async send(channelId: string, embeds: ReadonlyArray<APIEmbed>): Promise<void> {
    if (this.fail) throw new Error("cannot send");
    this.sentHistory.push({ channelId, embeds: structuredClone(embeds) });
  }
}

export class FakeServers extends ServerDirectory {
  public ids: ServerId[] = [];

  public serverIds(): ServerId[] {
    return [...this.ids];
  }
}
