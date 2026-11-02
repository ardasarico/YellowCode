---
name: run-tui
description: Launch YellowCode in a tmux session, send keys, and read the screen. Use to see a UI change working in the real terminal app, or to reproduce a rendering or input bug.
---

# Run the TUI

The app is a full-screen terminal UI, so run it inside a detached tmux session
and read the screen as text.

## Start

```bash
S=yellowcode-tui
tmux kill-session -t $S 2>/dev/null
tmux new-session -d -s $S -x 120 -y 40 -c "$PWD" 'bun run dev --replay fixtures/sessions/chat.jsonl --skip-terminal-check; echo "[exited $?]"; sleep 600'
```

`--replay` plays a recording from `fixtures/sessions/`; any of them works.
Use a replay for UI work: it needs no account and plays the same every time.

The trailing `echo` and `sleep` keep the pane open after the app exits, so a
crash and its exit code stay readable.

### Live

Without `--replay` the app starts a real agent in its working directory, with
the user's account, settings and tools. It opens the provider of the last used
model, else the first added one; `/providers` adds and removes providers. A
replay is always a Claude Code recording. Isolate a live run:

- Run it in a throwaway directory (a fresh `git init` repo under `/tmp`), with
  the app started through `bin/yellowcode` by its absolute path, so tools cannot
  touch this repo. Outside the repo `bun src/index.tsx` would miss the preload
  in `bunfig.toml` and fetch other package versions; the launcher does not.
- Drop the variables a parent Claude Code session passes down (`CLAUDECODE`,
  `CLAUDE_CODE_*`, `CLAUDE_EFFORT`, `CLAUDE_PID`), or the child picks up the
  parent's session id, plugin dirs and effort.
- Pick a cheap model with `ANTHROPIC_MODEL`, and use a private tmux socket
  (`-L`) so the user's tmux server is not touched.

```bash
D=/tmp/yc-live-run && rm -rf $D && mkdir -p $D && git -C $D init -q
APP="$PWD/bin/yellowcode"
UNSET=$(env | grep -oE '^(CLAUDECODE|CLAUDE_CODE_[A-Z_]+|CLAUDE_EFFORT|CLAUDE_PID)=' | tr -d = | sed 's/^/-u /' | tr '\n' ' ')
tmux -L yc kill-session -t $S 2>/dev/null
tmux -L yc new-session -d -s $S -x 120 -y 40 -c $D "env $UNSET ANTHROPIC_MODEL=haiku $APP --skip-terminal-check; echo \"[exited \$?]\"; sleep 600"
```

Pass `-L yc` to every `tmux` command below for such a session. The app logs
`claude started` and `claude exited` to `~/.yellowcode/logs/yellowcode.log`
(or `$YELLOWCODE_LOG_DIR`). After quitting, check that no claude is left:
`pgrep -fl -- --input-format=stream-json`.

With Codex or opencode, `ANTHROPIC_MODEL` does nothing; pick a cheap model in
the app with `/model` instead.

- Codex: each session runs its own `codex app-server` in the working directory,
  with the user's `~/.codex`. After quitting, check that none is left:
  `pgrep -fl 'codex app-server'`.
- opencode: the app connects to the user's shared opencode service, or starts
  `opencode serve --service`, which keeps running after the app quits. Leave
  that service alone: other opencode windows use it.

For runs that must not touch the user's Codex or opencode files, use the
recorders in `tools/codex/` and `tools/opencode/` instead; they run the agent
in a throwaway home against a mock model API.

## Wait for the screen

Never read the screen right after starting or sending keys. Poll for text you
expect instead:

```bash
for i in $(seq 50); do tmux capture-pane -p -t $S | grep -q '/ commands' && break; sleep 0.1; done
```

## Read the screen

```bash
tmux capture-pane -p -t $S      # plain text
tmux capture-pane -p -e -t $S   # with ANSI colors and styles
```

A capture can catch a half-drawn frame: tmux updates its grid while a frame is
still arriving, and a real terminal only shows complete frames. Before
reporting missing or repeated lines, capture again until two captures in a row
match.

## Interact

```bash
tmux send-keys -t $S q              # a key
tmux send-keys -t $S Enter          # also Escape, Tab, BSpace, Up, Down, C-c
tmux send-keys -t $S -l 'some text' # literal text
tmux resize-window -t $S -x 80 -y 24
```

After each action, wait for the expected change before reading the screen.

Shift+Enter and the redo keys (Ctrl+Shift+Z, Ctrl+.) cannot be sent through
tmux; use `C-j` for a newline.

## Stop

```bash
tmux kill-session -t $S
```

Always stop the session when done, including after a failure.
