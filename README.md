# Proton Mail MCP

An [MCP](https://modelcontextprotocol.io) server that lets Claude, and any
other MCP client, read and organise your Proton Mail. It talks to
[Proton Mail Bridge](https://proton.me/mail/bridge) on your own machine, so
your mail never passes through anything else.

It is built to be safe to leave connected:

- **Drafts, not sending.** Claude writes drafts for you to review and send.
  Sending straight away is off unless you turn it on.
- **Nothing is permanently deleted.** Deleting moves mail to Trash.
- **Email is treated as untrusted.** The server tells the client that
  instructions inside a message are not to be followed, and marks every tool
  as read-only or as changing mail, so a client can ask before anything
  changes.
- **No double actions.** Saving a draft, moving, labelling, deleting and
  sending are never retried automatically, so a dropped connection cannot
  leave a duplicate draft or send a message twice.
- **Attachments only from folders you allow.** Files can be attached to drafts
  only from Documents, Downloads and Desktop by default, and never hidden
  files, so a malicious email cannot talk Claude into attaching your SSH keys.

## What it can do

| Tool | What it does |
| --- | --- |
| `list_folders` | Folders, your own folders under `Folders/`, and labels under `Labels/` |
| `list_emails` | Messages in a folder, newest first, a page at a time |
| `search_emails` | Search by sender, recipient, subject, text, dates, unread or flagged |
| `read_email` | A message's text and attachments (see below) |
| `read_attachment` | One attachment: images to look at, PDF text, text files, other files |
| `create_draft` | A new email in Drafts, optionally with attached files |
| `create_reply_draft` | A threaded reply in Drafts, quoting the original |
| `move_email` | Move to another folder |
| `mark_email` | Read, unread, flagged or unflagged |
| `delete_email` | Move to Trash |
| `add_label`, `remove_label` | Apply or remove one of your Proton labels |
| `send_email`, `reply_to_email` | Send straight away; only with `PROTON_BRIDGE_ALLOW_SEND` |

`read_email` returns the plain text of a message. When a message has only
HTML (or a plain-text part that is just invisible padding, as newsletters
often have) the text is taken from the HTML. The raw HTML is left out unless
asked for, because it usually repeats the text at many times the size.

Attachments are where the facts often are, so `read_email` includes:

- the text of PDFs (invoices, tickets, contracts), page by page;
- calendar invites, parsed into the event's time, place, organiser and
  attendees, with the time zone as written;
- text attachments such as CSV files.

`read_attachment` returns images as images the model can look at, which is how
a scanned receipt or a photographed ticket gets read.

Replies go where mail clients send them: to the `Reply-To` address if the
sender set one, to the original recipients when you reply to your own message,
and with reply-all, to everyone else on Cc.

## Requirements

- Node.js 22.18 or newer
- [Proton Mail Bridge](https://proton.me/mail/bridge), signed in and running
- An MCP client, such as Claude Code or Claude Desktop

## Set up

```bash
git clone https://github.com/galengreen/proton-mail-mcp.git
cd proton-mail-mcp
npm ci          # installs and builds
```

Put your Bridge login in `~/.proton-bridge-credentials`. Use the password the
Bridge app shows for your account (IMAP and SMTP share it), not your Proton
password.

```bash
PROTON_BRIDGE_USERNAME="you@proton.me"
PROTON_BRIDGE_PASSWORD="the Bridge password"
```

```bash
chmod 600 ~/.proton-bridge-credentials
```

### Claude Code

```bash
claude mcp add --scope user proton-mail -- node /absolute/path/to/proton-mail-mcp/dist/index.js
```

### Claude Desktop

Add this to `claude_desktop_config.json` (on macOS in
`~/Library/Application Support/Claude/`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "proton-mail": {
      "command": "node",
      "args": ["/absolute/path/to/proton-mail-mcp/dist/index.js"]
    }
  }
}
```

If `node` is not found, use the full path that `which node` prints.

## Settings

Each setting can go in the environment or in `~/.proton-bridge-credentials`.
The environment wins when both have it.

| Setting | Default | Meaning |
| --- | --- | --- |
| `PROTON_BRIDGE_USERNAME` | (required) | Your Proton address, as shown in Bridge |
| `PROTON_BRIDGE_PASSWORD` | (required) | The Bridge password |
| `PROTON_BRIDGE_HOST` | `127.0.0.1` | Where Bridge runs |
| `PROTON_BRIDGE_IMAP_PORT` | `1143` | Bridge's IMAP port |
| `PROTON_BRIDGE_SMTP_PORT` | `1025` | Bridge's SMTP port |
| `PROTON_BRIDGE_SMTP_SECURE` | off | Set to `true` if Bridge's SMTP is set to SSL instead of STARTTLS |
| `PROTON_BRIDGE_ALLOW_SEND` | off | Set to `true` to add `send_email` and `reply_to_email` |
| `PROTON_BRIDGE_ATTACHMENT_DIRS` | `~/Documents:~/Downloads:~/Desktop` | Folders draft attachments may come from, separated by `:` |
| `PROTON_BRIDGE_IDLE_TIMEOUT_MS` | `300000` | Close the IMAP connection after this long unused |
| `PROTON_BRIDGE_SMTP_IDLE_TIMEOUT_MS` | `120000` | Close the SMTP connection after this long unused |
| `PROTON_BRIDGE_CREDENTIALS_FILE` | `~/.proton-bridge-credentials` | Where to read the settings file from (environment only) |

For a Bridge on this machine, its self-signed certificate is accepted, since
the connection never leaves the machine. For any other host, certificates are
checked and encryption is required.

## Protocol

The server speaks the MCP
[2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
protocol and the 2025 protocols before it, choosing whichever the client
opens with. It uses version 2 of the official TypeScript SDK.

## Troubleshooting

- **The tools do not appear:** check the path in your client's configuration,
  restart the client, and make sure Bridge is running.
- **Login fails:** use the Bridge password from the Bridge app, not your
  Proton password.
- **Mail actions fail:** check that Bridge is listening on the ports above.
  Run `node dist/index.js` in a terminal to see the server's messages.
- **A send failed with "may or may not have gone out":** the connection
  dropped mid-send. Look in Sent before sending again.

## Development

```bash
npm test        # the tests, run on the TypeScript source with no Bridge needed
npm run check   # type checking
npm run build   # compile to dist/
```

The tests run every tool against an in-memory mailbox that behaves like
Bridge, and start the real server over stdio with both an old-protocol and a
2026-07-28 client.

## Licence

MIT. See [LICENSE](LICENSE).
