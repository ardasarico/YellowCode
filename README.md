<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="YellowCode" width="400">
  </picture>
</p>

<p align="center">Keep your agent, change the screen.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="License: GPL-3.0"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey" alt="Platform: macOS and Linux">
</p>

<p align="center">
  <a href="#install">Install</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="docs/README.md">Docs</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="docs/mods.md">Mods</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="docs/themes.md">Themes</a>
</p>

## Install

```sh
# Install script
curl -fsSL https://raw.githubusercontent.com/ardasarico/YellowCode/main/install.sh | bash

# Package managers
npm i -g yellowcode
bun add -g yellowcode
pnpm add -g yellowcode
yarn global add yellowcode
brew install ardasarico/tap/yellowcode   # macOS and Linux
```

Then run `yellowcode` in your project. You need macOS or Linux and a [supported agent](#supported-agents), installed
and logged in. See [Usage](docs/usage.md) for the rest.

> [!TIP]
> We recommend [Ghostty](https://ghostty.org). Images in the chat need a terminal that can draw them, such as Ghostty or
> [kitty](https://sw.kovidgoyal.net/kitty/). Other terminals work too, just without images.

## What you get

- **Paste images into the prompt.** Copy a screenshot or an image file and paste it. You see it before you send.
- **Images and diagrams in the chat.** Mermaid diagrams, charts and the images your agent looks at are drawn on
  screen, not printed as text.
- **Rewind that brings your files back.** Go back to an earlier message and the whole project goes back with it: files
  changed by shell commands, formatters and background agents too, not only the agent's own edits. `/redo` undoes the
  rewind.
- **Mods.** Add your own commands, panes, sidebar sections and tools in TypeScript.

## Supported agents

| Agent              | Status         |
| ------------------ | -------------- |
| Claude Code        | ✅ Works       |
| Codex CLI          | ⏳ In progress |
| GitHub Copilot CLI | ⏳ In progress |
| Cursor CLI         | ⏳ In progress |
| opencode           | ⏳ In progress |

## How it works

YellowCode starts the agent you already use, on your own account, and draws what it sends back. It never reads your
credentials or talks to a model provider itself. What it adds to your session is listed in
[How it works](docs/how-it-works.md#what-yellowcode-adds-to-your-session).

## FAQ

<details>
<summary><b>Is YellowCode another coding agent?</b></summary>
<br>
No. It has no model or tools of its own. It runs the agent you already have and gives it a new screen.
</details>

<details>
<summary><b>Do my settings, MCP servers, skills and plugins still work?</b></summary>
<br>
Yes. They belong to your agent and load as usual.
</details>

<details>
<summary><b>Does it work on Windows?</b></summary>
<br>
Run it inside WSL. It works there the same way it does on Linux.
</details>

<details>
<summary><b>Who is behind it?</b></summary>
<br>
YellowCode is made by <a href="https://github.com/ardasarico">Arda Sarı</a> as an independent open-source project. It
is not affiliated with the companies that make the agents.
</details>

## Contributing

Found a bug? Open a [bug report](https://github.com/ardasarico/YellowCode/issues/new?template=bug.yml). Want
something new? Open a [feature request](https://github.com/ardasarico/YellowCode/issues/new?template=feature.yml). To
work on the code, see [Contributing](CONTRIBUTING.md).

## License

[GPL-3.0](LICENSE).
