---
name: probe-protocol
description: Look up or verify the claude stream-json protocol. Use before writing or changing code that sends to or parses messages from the claude binary, and after Claude Code is updated.
---

# Probe protocol

The stream-json protocol has no official reference. Never guess message shapes;
use these three sources, in this order.

## 1. Types: the matching Agent SDK `sdk.d.ts`

The TypeScript Agent SDK is released with Claude Code: CLI `2.1.X` matches SDK
`0.3.X`. Fetch the type file for the installed version:

```bash
V=$(claude --version | cut -d' ' -f1)
D=.local/sdk/$V
mkdir -p $D
npm pack "@anthropic-ai/claude-agent-sdk@0.3.${V##*.}" --pack-destination $D --silent
tar -xzf $D/*.tgz -C $D package/sdk.d.ts && rm $D/*.tgz
```

Read `$D/package/sdk.d.ts` (search for `SDKMessage`, `SDKControl`, the
`subtype` you need). It is a reference only: never add the SDK as a dependency
or import it.

## 2. Changes: the SDK changelog

After a Claude Code update, read the entries between the old and new versions:

```bash
curl -fsSL https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md
```

Each entry ends with "Updated to parity with Claude Code vX". If the mapping in
step 1 ever breaks, use this line to find the right SDK version.

## 3. Behavior: run the real binary

Types say what a message looks like, not when or in what order it arrives. To
see that, run a scenario against the installed `claude`:

```bash
bun .claude/skills/probe-protocol/probe.ts <text|tool|permission|subagent|control>
```

It runs `claude` in a temporary directory with Haiku and the default permission
mode, approves permission prompts, saves every message to
`.local/probes/<version>/<scenario>.jsonl`, and prints a count and one shortened
example per message kind. Each run costs a few cents. The user's own hooks,
plugins, and MCP servers load, so their events appear too.

To probe something new, add a scenario to `scenarios` in `probe.ts`. When types
and observed behavior disagree, trust the observed behavior.
