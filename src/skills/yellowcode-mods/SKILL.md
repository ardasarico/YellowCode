---
name: yellowcode-mods
description: Write, change or debug a YellowCode mod — a TypeScript add-on that adds commands, shortcuts, panes, sidebar sections, dialogs, tool rows, code fences, overrides, agent tools or MCP servers to YellowCode. Use when the user wants YellowCode itself to do or show something new.
---

`mod-api.md` is the full API of the installed version; read the parts you need before writing code. `examples/` holds the official Git, csv and terminal mods.

Work like this:

1. Make the mod in `~/.yellowcode/mods/<id>/` (under `$YELLOWCODE_HOME` when set): `yellowcode-mod.json` (copy the `api` range from the manifest in `mod-api.md`) and an entry file whose default export is `defineMod(...)` from `yellowcode/mod`.
2. A new mod folder loads on the next start. Tell the user to restart YellowCode; after that, Ctrl+R on the mod in `/mods` reloads the entry file (files it imports need a restart).
3. You cannot see the screen. Check the result in `/mods` (load time, what it adds, last error) and in `~/.yellowcode/logs/yellowcode.log`, lines starting `[mod <id>]`; ask the user what they see.

Pitfalls:

- A mod that throws in setup, a handler or a view is turned off at once; catch errors in your own timers, sockets and promises and log them.
- `setup` has 5 seconds.
- Mods run with no sandbox; do not add network calls or file writes the user did not ask for.
- Theme colours are not mods: point the user to themes in the `yellowcode-docs` skill.
