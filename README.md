# pi-sagent

Open [pi-subagents](https://github.com/nicobailon/pi-subagents) children inside the main [pi](https://github.com/earendil-works/pi) window instead of a separate pane: the child's transcript is drawn with pi's own components (thinking, tool calls, `Ctrl+O`), and the editor underneath talks to the child.

Status: early. Async (background) children only.

## Install

```sh
pi install git:github.com/alexbi29/pi-sagent
```

Requires pi-subagents to be installed.

## Use

- In FleetView (`/subagents-fleet`, or `↓` on an empty editor and then Enter), select a running child and press Enter.
- Or run `/sagent <async run dir> [child index]`.

In the view:

| Key (pi keybinding) | Action |
|---|---|
| Enter (`tui.input.submit`) | Send the message to the child: steers a busy child, queues a follow-up for an idle one |
| Esc (`app.interrupt`) | Interrupt the child |
| Ctrl+O (`app.tools.expand`) | Expand or collapse tool output |
| `app.thinking.toggle` | Show or hide thinking |
| PageUp/PageDown, wheel | Scroll |
| Ctrl+D (`app.exit`, empty editor) | Close the view |

Keys follow your `~/.pi/agent/keybindings.json`.

Inside tmux, pi-subagents' own tmux inspector takes Fleet's Enter; use `/sagent` there.

## How it works

pi-sagent registers an inspector plugin through pi-subagents' public `pi-subagents:inspector-register:v1` event and sends steer and interrupt requests through its in-process RPC (`subagents:rpc:v1:*`). The transcript is read from the child's `session.jsonl`.

## License

MIT
