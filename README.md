# pi-attach

Open [pi-subagents](https://github.com/nicobailon/pi-subagents) children inside the main [pi](https://github.com/earendil-works/pi) window instead of a separate pane: the child's transcript is drawn with pi's own components (thinking, tool calls, `Ctrl+O`), and the editor underneath talks to the child.

Status: early. Async (background) children only.

## Install

```sh
pi install git:github.com/alexbi29/pi-attach
```

Requires pi-subagents to be installed.

## Use

- `alt+a` or `/attach`: pick one of this session's subagents, newest first, running or finished.
- In FleetView (`/subagents-fleet`, or `↓` on an empty editor and then Enter), select a running child and press Enter.
- `/attach <async run dir> [child index]` opens a run directly.

Inside tmux, pi-subagents' own tmux inspector takes Fleet's Enter; `alt+a` and `/attach` still work.

The view follows the child live: text and thinking stream token by token, running tools show their output as it arrives, and the header shows agent, model, state, tokens, tool count and elapsed time. Scrolled-up content stays in place while new output arrives; sending a message jumps back to the end.

In the view:

| Key (pi keybinding) | Action |
|---|---|
| Enter (`tui.input.submit`) | Send the message to the child: steers a running child (or queues a follow-up when it is between turns); resumes a paused, finished or failed child, and the view follows the resumed run |
| Esc (`app.interrupt`) | Interrupt the child |
| Ctrl+O (`app.tools.expand`) | Expand or collapse tool output |
| `app.thinking.toggle` | Show or hide thinking |
| PageUp/PageDown, wheel | Scroll |
| Ctrl+D (`app.exit`, empty editor) | Close the view |

Keys follow your `~/.pi/agent/keybindings.json`.

## Configuration

`~/.pi/agent/extensions/pi-attach/config.json`, all keys optional:

```json
{ "pickerShortcut": "alt+a" }
```

`pickerShortcut` is the key that opens the picker; `false` registers none. Restart pi or run `/reload` after changing it.

## How it works

pi-attach registers an inspector plugin through pi-subagents' public `pi-subagents:inspector-register:v1` event and sends steer, interrupt and resume requests through its in-process RPC (`subagents:rpc:v1:*`). The transcript is read from the child's `session.jsonl`.

Streaming needs pi-attach inside the child too. pi-subagents loads your installed extensions into every child by default, and there pi-attach only listens on a local Unix socket (`<tmpdir>/pi-attach-<uid>/`, owner-only) and forwards streaming updates to a connected view. It sends nothing while no view is connected. If you restrict child extensions with `subagents.defaultExtensions`, add pi-attach to `subagents.defaultSubagentOnlyExtensions`; without it the view still updates once per finished message.

Streaming uses Unix sockets and is not available on Windows.

## License

MIT
