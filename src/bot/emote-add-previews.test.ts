import { expect, mock, spyOn, test } from "bun:test";
import { PreparedEmoteUpload, type EmoteAddConfirmation } from "../core/index.ts";
import { EmoteAddInteraction, type EmoteAddAction } from "./emote-add-interaction.ts";
import { EmoteAddPreviews } from "./emote-add-previews.ts";

class Interaction extends EmoteAddInteraction {
  public readonly reply = mock(async (_text: string) => {});
  public readonly showNameForm = mock(async (_originalName: string) => {});
  public readonly defer = mock(async () => {});

  public constructor(
    public readonly previewId: string,
    public readonly action: EmoteAddAction,
    public readonly userId = "admin",
    public readonly serverId = "server",
    public readonly isAdministrator = true,
  ) {
    super();
  }
}

function setup() {
  const addEmote = mock(async (): Promise<EmoteAddConfirmation> => ({ changes: [], feedback: [{ level: "info", text: "Added Name." }] }));
  const previews = new EmoteAddPreviews({ addEmote });
  const emote = { id: "emote", name: "Original Name", animated: false };
  const previewImage = { bytes: new Uint8Array([1, 2, 3]), animated: false };
  const prepared = new PreparedEmoteUpload(emote, "Original_Name", previewImage);
  const reply = previews.open("server", "admin", "search", { emote, previewImage, prepared, slotNotice: "Slot notice" });
  if (typeof reply === "string" || !("originalName" in reply) || reply.id === undefined) throw new Error("Expected an actionable preview");
  return { addEmote, previews, prepared, reply, id: reply.id };
}

test("renders the preview, opens the form, and uses core-supplied retry guidance", async () => {
  const { addEmote, previews, reply, id, prepared } = setup();
  expect(reply).toMatchObject({ originalName: "Original Name", defaultName: "Original_Name", slotNotice: "Slot notice" });
  const form = new Interaction(id, { kind: "name" });
  await previews.handleInteraction(form);
  expect(form.showNameForm).toHaveBeenCalledWith("Original Name");
  const invalid = new Interaction(id, { kind: "submit", name: "Name with spaces" });
  await previews.handleInteraction(invalid);
  expect(invalid.reply.mock.calls[0]?.[0]).toContain("2–32 characters");
  expect(addEmote).not.toHaveBeenCalled();
  addEmote.mockResolvedValueOnce({ changes: [], feedback: [{ level: "error", text: "Try another.", retry: "to choose again." }] });
  const submit = new Interaction(id, { kind: "submit", name: "Valid" });
  await previews.handleInteraction(submit);
  expect(submit.defer).toHaveBeenCalledTimes(1);
  expect(addEmote).toHaveBeenCalledWith("server", prepared, "Valid");
  expect(submit.reply.mock.calls[0]?.[0]).toContain("Run `/search` again to choose again.");
});

test("only the initiating admin in the same Server can use a preview", async () => {
  const { addEmote, previews, id } = setup();
  const action = { kind: "add" } as const;
  const requests = [new Interaction(id, action, "other"), new Interaction(id, action, "admin", "other"),
    new Interaction(id, action, "admin", "server", false)];
  for (const request of requests) {
    await previews.handleInteraction(request);
    expect(request.defer).not.toHaveBeenCalled();
  }
  expect(addEmote).not.toHaveBeenCalled();
  await previews.handleInteraction(new Interaction(id, action));
  expect(addEmote).toHaveBeenCalledTimes(1);
});

test("expiry invalidates both the Add button and an already opened form", async () => {
  const { addEmote, previews, id } = setup();
  await previews.handleInteraction(new Interaction(id, { kind: "name" }));
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 30 * 60_000);
  try {
    for (const action of [{ kind: "add" }, { kind: "submit", name: "Valid" }] as const) {
      const request = new Interaction(id, action);
      await previews.handleInteraction(request);
      expect(request.reply.mock.calls[0]?.[0]).toContain("no longer active");
    }
    expect(addEmote).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});

test("cancelling a preview also invalidates its naming form", async () => {
  const { addEmote, previews, id } = setup();
  await previews.handleInteraction(new Interaction(id, { kind: "name" }));
  const cancel = new Interaction(id, { kind: "cancel" });
  await previews.handleInteraction(cancel);
  expect(cancel.reply.mock.calls[0]?.[0]).toContain("Cancelled");
  const submit = new Interaction(id, { kind: "submit", name: "Valid" });
  await previews.handleInteraction(submit);
  expect(submit.reply.mock.calls[0]?.[0]).toContain("no longer active");
  expect(addEmote).not.toHaveBeenCalled();
});

test.each(["add", "submit"] as const)("only %s confirms when it wins a button/form race", async (first) => {
  const { addEmote, previews, id, prepared } = setup();
  const add = new Interaction(id, { kind: "add" });
  const submit = new Interaction(id, { kind: "submit", name: "Valid" });
  const [winner, loser] = first === "add" ? [add, submit] : [submit, add];
  await Promise.all([previews.handleInteraction(winner), previews.handleInteraction(loser)]);
  expect(addEmote).toHaveBeenCalledTimes(1);
  expect(addEmote).toHaveBeenCalledWith("server", prepared, first === "add" ? undefined : "Valid");
  expect(winner.reply.mock.calls[0]?.[0]).toContain("Added Name");
  expect(loser.reply.mock.calls[0]?.[0]).toContain("no longer active");
});
