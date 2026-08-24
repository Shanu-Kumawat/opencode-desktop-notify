# opencode-caelestia-notify

Desktop notifications for [opencode](https://opencode.ai) — built for [Caelestia shell](https://github.com/caelestia-dots/shell) users, works on any Hyprland/Wayland setup with `notify-send`.

Get a popup the moment opencode finishes a task, hits an error, needs a permission approval, or asks you a question. No more staring at the terminal.

## Features

| Event | Notification |
|---|---|
| `session.idle` | "ready" popup + session title (normal urgency) |
| `session.error` | error detail in body (critical) |
| `permission.asked` / `permission.updated` | "waiting for you" (critical, deduped) |
| `question.asked` | "question for you" (critical) |

- Session title is fetched via the opencode SDK and included in every popup, so multi-session users know which one is talking
- Duplicate-event dedupe (opencode can emit repeated idle events)
- Optional focus suppression: skips "ready" popups while your terminal is focused — errors/permissions/questions always come through
- Uses your existing notification daemon styling and sounds (Caelestia/swaync handles it) — no extra sound setup
- Zero npm dependencies, single file, plain JS

## Requirements

- [opencode](https://opencode.ai)
- A working `notify-send` (libnotify) + notification daemon. Caelestia ships this out of the box; other Hyprland users can install `swaync`, `mako`, or `dunst`

Test yours first:

```sh
notify-send -u low -i dialog-information-symbolic 'Test notification'
```

## Install

```sh
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://raw.githubusercontent.com/Shanu-Kumawat/opencode-caelestia-notify/main/notify.js \
  -o ~/.config/opencode/plugins/notify.js
```

That's it — opencode auto-loads global plugins at startup. Restart any running sessions.

## Configuration

Edit the constants at the top of `notify.js`:

```js
const APP = "opencode"
const SUPPRESS_WHEN_TERMINAL_FOCUSED = true   // skip "ready" popups when terminal focused
const TERMINAL_CLASSES = ["kitty", "foot", ...] // classes treated as terminals
```

Environment variable overrides:

```sh
OPENCODE_NOTIFY_NO_SUPPRESS=1        # disable focus suppression for one run
OPENCODE_NOTIFY_DEBUG=/tmp/log.txt   # log every notification/suppression to a file
```

## Troubleshooting

- **No popups** — run the test command above; if it fails, your notification daemon isn't running (`systemctl --user status swaync`)
- **Popups only when terminal unfocused** — that's the suppression feature; add your terminal's class to `TERMINAL_CLASSES` or set `SUPPRESS_WHEN_TERMINAL_FOCUSED = false`
- **Plugin not loading** — check `~/.config/opencode/plugins/` path and restart opencode

## License

[MIT](LICENSE)
