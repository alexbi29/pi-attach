# pi-sagent

Open [pi-subagents](https://github.com/nicobailon/pi-subagents) children inside the main [pi](https://github.com/earendil-works/pi) window instead of a separate pane: the child's transcript is drawn with pi's own components (thinking, tool calls, `Ctrl+O`), and the editor underneath talks to the child.

Status: early. Async (background) children only.

## Install

```sh
pi install git:github.com/alexbi29/pi-sagent
```

Requires pi-subagents to be installed.

## Use

- `alt+a` or `/sagent`: pick one of this session's subagents, newest first, running or finished.
- In FleetView (`/subagents-fleet`, or `↓` on an empty editor and then Enter), select a running child and press Enter.
- `/sagent <async run dir> [child index]` opens a run directly.

Inside tmux, pi-subagents' own tmux inspector takes Fleet's Enter; `alt+a` and `/sagent` still work.

The view follows the child live: new messages and tool calls appear as the child writes them, and the header shows agent, model, state, tokens, tool count and elapsed time. Scrolled-up content stays in place while new output arrives.

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

`~/.pi/agent/extensions/pi-sagent/config.json`, all keys optional:

```json
{ "pickerShortcut": "alt+a" }
```

`pickerShortcut` is the key that opens the picker; `false` registers none. Restart pi or run `/reload` after changing it.

## How it works

pi-sagent registers an inspector plugin through pi-subagents' public `pi-subagents:inspector-register:v1` event and sends steer, interrupt and resume requests through its in-process RPC (`subagents:rpc:v1:*`). The transcript is read from the child's `session.jsonl`.

## License

MIT
