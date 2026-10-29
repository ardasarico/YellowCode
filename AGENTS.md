# YellowCode

Terminal UI for coding agents. It runs Claude Code, Codex and opencode, one at a
time, each through the user's own unmodified binary and its own protocol: `claude`
over stream-json, `codex app-server` over JSON-RPC, and opencode's local service
over HTTP. The adapters live in `src/agents/`. Stack: TypeScript, Bun, OpenTUI
(Solid).

- Everything in this repo is written in English.
- Ask before every commit and push.
- Never show, store, log or send credentials. If an agent's API returns them,
  keep only the fields you need and drop the rest right away.
- Never call a model provider's API directly. Every request goes through the
  agent's own binary or service.
- Keep code plain. Add a comment only when the code cannot explain itself.
- Write tests only where they guard real risk, and keep them minimal.
