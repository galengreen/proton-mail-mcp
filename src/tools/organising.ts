import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Mailbox } from "../mailbox.ts";
import { CHANGES_MAIL, REMOVES_MAIL, folder, json, uid } from "./shared.ts";

const label = z.string().min(1).describe("Label name, e.g. \"Receipts\" (the folder Labels/Receipts in list_folders)");

export function registerOrganisingTools(server: McpServer, mailbox: Mailbox): void {
  server.registerTool("move_email", {
    title: "Move email",
    description: "Move a message to another folder, e.g. Archive or Folders/Receipts. Its UID changes; the new one is returned.",
    inputSchema: z.object({
      uid: uid(),
      folder: folder("Folder the message is in now"),
      destination: z.string().min(1).describe("Folder to move it to (see list_folders)")
    }),
    annotations: { ...CHANGES_MAIL, idempotentHint: false }
  }, async (args) => {
    const moved = await mailbox.move(args.folder, args.uid, args.destination);
    return json({ moved: true, from: args.folder, to: moved.destination, newUid: moved.uid });
  });

  server.registerTool("mark_email", {
    title: "Mark email",
    description: "Mark a message as read or unread, or flag (star) or unflag it.",
    inputSchema: z.object({
      uid: uid(),
      folder: folder("Folder the message is in"),
      action: z.enum(["read", "unread", "flag", "unflag"]).describe("What to do")
    }),
    annotations: CHANGES_MAIL
  }, async (args) => {
    await mailbox.setFlag(args.folder, args.uid, args.action);
    return json({ marked: true, uid: args.uid, action: args.action });
  });

  server.registerTool("delete_email", {
    title: "Delete email",
    description: "Move a message to Trash, where it can still be recovered. Nothing is deleted permanently.",
    inputSchema: z.object({
      uid: uid(),
      folder: folder("Folder the message is in")
    }),
    annotations: REMOVES_MAIL
  }, async (args) => {
    const moved = await mailbox.trash(args.folder, args.uid);
    return json({ deleted: true, movedTo: moved.destination, newUid: moved.uid });
  });

  server.registerTool("add_label", {
    title: "Add label",
    description: "Apply an existing Proton label to a message. The message stays where it is; labels are created in Proton Mail itself.",
    inputSchema: z.object({
      uid: uid(),
      folder: folder("Folder the message is in"),
      label
    }),
    annotations: CHANGES_MAIL
  }, async (args) => {
    const path = await mailbox.addLabel(args.folder, args.uid, args.label);
    return json({ labelled: true, uid: args.uid, label: path });
  });

  server.registerTool("remove_label", {
    title: "Remove label",
    description: "Take a Proton label off a message. Only the label is removed; the message stays in its folder.",
    inputSchema: z.object({
      uid: uid(),
      folder: folder("Folder the message is in"),
      label
    }),
    annotations: { ...CHANGES_MAIL, idempotentHint: false }
  }, async (args) => {
    const path = await mailbox.removeLabel(args.folder, args.uid, args.label);
    return json({ unlabelled: true, uid: args.uid, label: path });
  });
}
