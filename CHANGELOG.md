# Changelog

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
