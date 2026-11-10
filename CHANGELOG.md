# Changelog

## 0.3.0

### Added

- Paste an image into your answer when the agent asks you a question.
- A question from the agent comes with a short context, shown in the chat above it.

## 0.2.0

### Highlights

- **Mention models and agents.** Type `@` in the prompt to name a model or an agent from any of your providers, and
  your agent hands that part of the work to it.
- **The agent knows YellowCode.** Claude Code, Codex, opencode and Pi are told they run inside YellowCode, so they can
  answer questions about its commands, mods and themes and draw charts, diagrams and images in the chat.
- **Numbers at a glance.** New `stats` and `row` blocks show test results, sizes and short facts as a strip or tiles.

### Added

- Charts use one bar colour and have titles and legends.
- Mods can tell the agent about the blocks they draw.
- A cat word shows while the model thinks.

### Changed

- Long chats scroll smoothly while a reply streams in.
- Updates are checked every hour, and at once when you switch channels.

### Fixed

- Questions from the agent no longer point at a plan or result you have not seen.
- New Claude models show in `/model` even before they get a short name.
- A message sent during a turn stays below the turn until the agent takes it in.
- opencode, Codex and Pi list `/model`, `/effort`, `/context`, `/rename` and `/plan`.
- Commands run on a model you just picked go to that model's provider.
- A background task finishing no longer marks the turn as done.
- Matrix questions have a blank line between their rows.

## 0.1.1

### Fixed

- Claude in Chrome works in YellowCode when you turned it on in Claude Code with `/chrome`.

### Changed

- npm packages are published from GitHub Actions with signed provenance, and their pages have a README.

## 0.1.0

The first release. YellowCode runs Claude Code, Codex, opencode and Pi in one terminal UI, each through its own binary
and your own account.

### Highlights

- **Paste images.** Paste a screenshot or an image file into the prompt and see it before you send.
- **Images and diagrams in the chat.** Mermaid diagrams, charts and images are drawn, not printed as text.
- **Rewind with your files.** Go back to an earlier message and the project goes back too, whoever changed the files.
  `/redo` undoes it.
- **Every model in one picker.** `/model` lists the models of all your providers; pick another provider's and the chat
  moves there.
- **Subagents on any provider.** Hand a task to a Codex model from a Claude Code session and get the answer back.
- **Sessions that work together.** Your open sessions can send each other work, whichever provider each runs.
- **Mods.** Add your own commands, panes, sidebar sections and tools in TypeScript.
