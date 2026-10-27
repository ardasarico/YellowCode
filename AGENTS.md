# YellowCode

Terminal UI for coding agents. Today it runs Claude Code: it spawns the user's
unmodified `claude` binary and talks to it over stream-json. Stack: TypeScript, Bun,
OpenTUI (Solid).

- Everything in this repo is written in English.
- Ask before every commit and push.
- Never read or handle credentials, and never call the Anthropic API directly.
  All requests go through the `claude` binary.
- Keep code plain. Add a comment only when the code cannot explain itself.
- Write tests only where they guard real risk, and keep them minimal.
