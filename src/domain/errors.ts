import type { EmoteAddNameConflictReason, FeedbackMessage } from "./types.ts";
import type { Quota } from "./quota.ts";

/** An error the core turns into admin feedback instead of crashing. */
export abstract class DomainError extends Error {
  public abstract toFeedback(): FeedbackMessage;
}

export type LinkKind = "emote" | "user";

/** A link cannot be resolved. Thrown by ports, shown to the admin by the core. */
export class InvalidLinkError extends DomainError {
  public constructor(
    public readonly link: string,
    private readonly expected?: LinkKind,
  ) {
    super(`Not a valid 7TV link: ${link}`);
  }

  public toFeedback(): FeedbackMessage {
    if (!this.expected) return { level: "error", text: `"${this.link}" is not a valid 7TV link.` };
    const example = this.expected === "emote" ? "emotes" : "users";
    return {
      level: "error",
      text: `"${this.link}" is not a valid 7TV ${this.expected} link. Use a link like https://7tv.app/${example}/<id>.`,
    };
  }
}

/** The bot lacks Manage Expressions on a Server. Thrown by the Discord port, shown to the admin by the core. */
export class MissingPermissionError extends DomainError {
  public constructor(public readonly server: string) {
    super(`Missing Manage Expressions permission in server ${server}`);
  }

  public toFeedback(): FeedbackMessage {
    return {
      level: "error",
      text: "I am missing the Manage Expressions permission, so I cannot add, rename or remove emojis. Grant it to my role and run /sync again.",
    };
  }
}

/** Discord freed the slot but rejected the replacement upload. */
export class DisplacementError extends DomainError {
  public constructor(replacement: string, displaced: string, cause: unknown) {
    super(`Could not add ${replacement}. ${displaced} was displaced; the next sync will refill the slot by Precedence.`, { cause });
  }

  public toFeedback(): FeedbackMessage {
    const reason = this.cause instanceof DomainError ? " " + this.cause.toFeedback().text : "";
    return { level: "error", text: this.message + reason };
  }
}

/** The name confirmed from an emote preview cannot be applied as shown. */
export class EmoteAddNameConflictError extends DomainError {
  private constructor(private readonly reason: EmoteAddNameConflictReason, text: string) {
    super(text);
  }

  public static taken(name: string): EmoteAddNameConflictError {
    return new EmoteAddNameConflictError("emote-name-taken", `${name} is already in use.`);
  }

  public static changed(): EmoteAddNameConflictError {
    return new EmoteAddNameConflictError("emote-name-changed", "The Discord emoji name changed.");
  }

  public toFeedback(): FeedbackMessage {
    return { level: "error", text: this.message, reason: this.reason };
  }
}

/** A preview that could only promote a Managed Emote can no longer do so. */
export class EmoteAddPromotionUnavailableError extends DomainError {
  public constructor() {
    super("The Discord emoji shown in the preview is no longer managed by the bot. No emote was added.");
  }

  public toFeedback(): FeedbackMessage {
    return { level: "error", text: this.message, reason: "emote-promotion-unavailable" };
  }
}

/** The current Slot would require displacing a different Managed Emote than the admin saw. */
export class EmoteAddSlotChangedError extends DomainError {
  public constructor() {
    super("Which Managed Emote would be displaced has changed. No emote was added.");
  }

  public toFeedback(): FeedbackMessage {
    return { level: "error", text: this.message, reason: "emote-slot-changed" };
  }
}

/** No free slot in a quota and nothing of lower Precedence to displace. */
export class QuotaFullError extends DomainError {
  public constructor(
    public readonly quota: Quota,
    public readonly emoteName: string,
  ) {
    super(`No free ${quota} slot for ${emoteName}`);
  }

  public toFeedback(): FeedbackMessage {
    return {
      level: "error",
      text: `No free ${this.quota} slot for ${this.emoteName}: only Reserved Slots and Requested Emotes are left. Remove an emoji to make room.`,
    };
  }
}
