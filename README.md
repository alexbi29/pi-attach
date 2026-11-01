# pi-attach

Open [pi-subagents](https://github.com/nicobailon/pi-subagents) children inside the main [pi](https://github.com/earendil-works/pi) window instead of a separate pane: the child's transcript is drawn with pi's own components (thinking, tool calls, `Ctrl+O`), and the editor underneath talks to the child.

Status: early. Async (background) children only.

## Install

```sh
pi install git:github.com/alexbi29/pi-attach
```

Requires pi-subagents to be installed. To use pi-attach's list under the editor in place of pi-subagents' FleetView, turn FleetView off in `~/.pi/agent/extensions/subagent/config.json` and restart pi:

```json
{ "fleetView": false }
```

`/subagents-fleet` keeps working. With FleetView on, pi-attach leaves the space under the editor to it.

## Use

While this session has subagents running, or finished in the last ten minutes, one line under the editor counts them:

```
  2 running · 1 done · ↓ to open
```

`↓` on an empty editor opens the list, `↑↓` select, Enter opens the child, Tab shows older children (and Tab again hides them), Esc (or `↑` from the first row, or typing) goes back to the editor:

```
  › delegate  Run the test suite and report failures  deepseek-v4-flash  running  1m 20s   24k / 262k ctx
    reviewer  Review the diff in src/                 qwen3.8-flash      done        42s  210k / 262k ctx
    enter open · tab 3 older · esc back
```

Other ways in:

- `ctrl+shift+a` or `/attach` opens the same list from anywhere, even with text in the editor. When no child is recent, it opens on all of them.
- `/subagents-fleet`: select a running child and press Enter. Inside tmux, pi-subagents' own tmux inspector takes that Enter.
- `/attach <async run dir> [child index]` opens a run directly.

The view follows the child live: text and thinking stream token by token, running tools show their output as it arrives, and the header shows the agent, its run id and task, tool count and elapsed time; the row under the editor says which subagent you are talking to and its state; and the bottom line is pi's own stats line for the child: tokens in and out, context use, and `(provider) model • thinking`. Scrolled-up content stays in place while new output arrives; sending a message jumps back to the end.

In the view:

| Key (pi keybinding) | Action |
|---|---|
| Enter (`tui.input.submit`) | Send the message to the child: steers a running child (or queues a follow-up when it is between turns); resumes a paused, finished or failed child, and the view follows the resumed run |
| Ctrl+C (`app.clear`, empty editor) | Interrupt the child (a resumable pause); with text in the editor it clears the editor |
| Ctrl+O (`app.tools.expand`) | Expand or collapse tool output |
| `app.thinking.toggle` | Show or hide thinking |
| PageUp/PageDown, wheel | Scroll |
| Esc (`app.interrupt`), Ctrl+D (`app.exit`, empty editor) | Back to the main session; the child keeps running |

Keys follow your `~/.pi/agent/keybindings.json`.

## Configuration

`~/.pi/agent/extensions/pi-attach/config.json`, all keys optional:

```json
{ "listShortcut": "ctrl+shift+a" }
```

`listShortcut` is the key that opens the list; `false` registers none. Ctrl+Shift combinations need a terminal that reports them (most modern terminals, including iTerm2, Ghostty, kitty and WezTerm); `/attach` works everywhere. Restart pi or run `/reload` after changing it.

## How it works

The list reads pi-subagents' run records (`<tmpdir>/pi-subagents-<uid>/async-subagent-runs/*/status.json`) once a second, re-reading only runs still in flight. pi-attach registers an inspector plugin through pi-subagents' public `pi-subagents:inspector-register:v1` event and sends steer, interrupt and resume requests through its in-process RPC (`subagents:rpc:v1:*`). The transcript is read from the child's `session.jsonl`.

Streaming needs pi-attach inside the child too. pi-subagents loads your installed extensions into every child by default, and there pi-attach only listens on a local Unix socket (`<tmpdir>/pi-attach-<uid>/`, owner-only) and forwards streaming updates to a connected view. It sends nothing while no view is connected. If you restrict child extensions with `subagents.defaultExtensions`, add pi-attach to `subagents.defaultSubagentOnlyExtensions`; without it the view still updates once per finished message.

Streaming uses Unix sockets and is not available on Windows.

## License

MIT
