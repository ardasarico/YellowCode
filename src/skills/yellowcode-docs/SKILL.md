---
name: yellowcode-docs
description: How YellowCode works and how to use it — keys, / commands, providers and models, switching models, shared MCP servers, subagents, sessions, themes, installing and managing mods, the files it writes, updating and problems. Use when the user asks about "the app", the client, YellowCode, or something on its screen, before answering from memory.
---

The user runs you inside YellowCode. These files describe the installed version. Read the one that fits the question, then answer; do not guess what is not in them.

- `usage.md`: starting, keys, the prompt, commands, providers, models, shared MCP servers, files it writes, updating and uninstalling.
- `how-it-works.md`: how each provider runs, what YellowCode adds to a session, what it never does, what it keeps.
- `agents.md`: subagents on any provider, agent files, sessions working together.
- `mods.md`: installing, updating and managing mods. To write a mod, use the `yellowcode-mods` skill.
- `themes.md`: theme files, their format, and why one does not load.

If something looks broken, `/report` in the app copies (and `yellowcode --report` prints) a summary the user can share in a bug report.
