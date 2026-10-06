import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Mailbox, Moved } from "../mailbox.ts";
import { CHANGES_MAIL, REMOVES_MAIL, json, messageFolder, uidList, uids } from "./shared.ts";

const label = z.string().min(1).describe("Label name, e.g. \"Receipts\" (the folder Labels/Receipts in list_folders)");

/** Each message's new UID, plus newUid on its own when there is just one. */
function newUids(moved: Moved) {
  const [only] = moved.messages;
  return moved.messages.length === 1 && only ? { newUid: only.newUid, messages: moved.messages } : { messages: moved.messages };
}

export function registerOrganisingTools(server: McpServer, mailbox: Mailbox): void {
  server.registerTool("move_email", {
    title: "Move email",
    description: "Move one message, or several from the same folder, to another folder, e.g. Archive or Folders/Receipts. Their UIDs change; the new ones are returned. If any UID is missing, nothing is moved.",
    inputSchema: z.object({
      uid: uids(),
      folder: messageFolder("Folder the messages are in now"),
      destination: z.string().min(1).describe("Folder to move them to (see list_folders)")
    }),
    annotations: { ...CHANGES_MAIL, idempotentHint: false }
  }, async (args) => {
    const moved = await mailbox.move(args.folder, uidList(args.uid), args.destination);
    return json({ moved: true, from: args.folder, to: moved.destination, ...newUids(moved) });
  });

  server.registerTool("mark_email", {
    title: "Mark email",
    description: "Mark one message, or several from the same folder, as read or unread, or flag (star) or unflag them. If any UID is missing, nothing is changed.",
    inputSchema: z.object({
      uid: uids(),
      folder: messageFolder(),
      action: z.enum(["read", "unread", "flag", "unflag"]).describe("What to do")
    }),
    annotations: CHANGES_MAIL
  }, async (args) => {
    const list = uidList(args.uid);
    await mailbox.setFlag(args.folder, list, args.action);
    return json({ marked: true, uids: list, action: args.action });
  });

  server.registerTool("delete_email", {
    title: "Delete email",
    description: "Move one message, or several from the same folder, to Trash, where they can still be recovered. Nothing is deleted permanently. If any UID is missing, nothing is moved.",
    inputSchema: z.object({
      uid: uids(),
      folder: messageFolder()
    }),
    annotations: REMOVES_MAIL
  }, async (args) => {
    const moved = await mailbox.trash(args.folder, uidList(args.uid));
    return json({ deleted: true, movedTo: moved.destination, ...newUids(moved) });
  });

  server.registerTool("add_label", {
    title: "Add label",
    description: "Apply an existing Proton label to one message, or several from the same folder. The messages stay where they are; labels are created in Proton Mail itself.",
    inputSchema: z.object({
      uid: uids(),
      folder: messageFolder(),
      label
    }),
    annotations: CHANGES_MAIL
  }, async (args) => {
    const list = uidList(args.uid);
    const path = await mailbox.addLabel(args.folder, list, args.label);
    return json({ labelled: true, uids: list, label: path });
  });

  server.registerTool("remove_label", {
    title: "Remove label",
    description: "Take a Proton label off one message, or several from the same folder. Only the label is removed; the messages stay in their folder.",
    inputSchema: z.object({
      uid: uids(),
      folder: messageFolder(),
      label
    }),
    annotations: { ...CHANGES_MAIL, idempotentHint: false }
  }, async (args) => {
    const list = uidList(args.uid);
    const path = await mailbox.removeLabel(args.folder, list, args.label);
    return json({ unlabelled: true, uids: list, label: path });
  });
}
