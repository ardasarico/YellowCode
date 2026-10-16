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

`--replay` is required; any recording in `fixtures/sessions/` works.

The trailing `echo` and `sleep` keep the pane open after the app exits, so a
crash and its exit code stay readable.

## Wait for the screen

Never read the screen right after starting or sending keys. Poll for text you
expect instead:

```bash
for i in $(seq 50); do tmux capture-pane -p -t $S | grep -q 'enter send' && break; sleep 0.1; done
```

## Read the screen

```bash
tmux capture-pane -p -t $S      # plain text
tmux capture-pane -p -e -t $S   # with ANSI colors and styles
```

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
