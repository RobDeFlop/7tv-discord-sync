import type { ServerId } from "../domain/index.ts";
import { LogChannel } from "../bot/feedback-router.ts";
import { ServerDirectory } from "../bot/gateway-events.ts";

export class FakeLogChannel extends LogChannel {
  public readonly sent: { channelId: string; text: string }[] = [];
  public fail = false;

  public async send(channelId: string, text: string): Promise<void> {
    if (this.fail) throw new Error("cannot send");
    this.sent.push({ channelId, text });
  }
}

export class FakeServers extends ServerDirectory {
  public ids: ServerId[] = [];

  public serverIds(): ServerId[] {
    return [...this.ids];
  }
}
