# YellowCode

Terminal UI for coding agents. Today it runs Claude Code: it spawns the user's
unmodified `claude` binary and talks to it over stream-json. Stack: TypeScript, Bun,
OpenTUI (Solid).

- Everything in this repo is written in English.
- Ask before every commit and push.
- Never show, store, log or send credentials. If an agent's API returns them,
  keep only the fields you need and drop the rest right away.
- Never call a model provider's API directly. Every request goes through the
  agent's own binary.
- Keep code plain. Add a comment only when the code cannot explain itself.
- Write tests only where they guard real risk, and keep them minimal.
