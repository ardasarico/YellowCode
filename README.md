<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="YellowCode" width="400">
  </picture>
</p>

<p align="center">Keep your agents, change the screen.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="License: GPL-3.0"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey" alt="Platform: macOS and Linux">
</p>

<p align="center">
  <a href="#install">Install</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="docs/README.md">Docs</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="docs/mods.md">Mods</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="docs/themes.md">Themes</a>
</p>

YellowCode is a better terminal for Claude Code, Codex, opencode and Pi. It runs the agents you already have, on your
own accounts. Use one, or use them together: every model in one picker, with the same MCP servers and memory behind
each.

## Install

```sh
# Install script
curl -fsSL https://raw.githubusercontent.com/ardasarico/YellowCode/main/install.sh | bash

# Package managers
npm i -g yellowcode
bun add -g yellowcode
pnpm add -g yellowcode
```

Then run `yellowcode` in your project.

- **Requirements:** macOS or Linux, and at least one [supported provider](#supported-providers) installed and logged
  in. The first run asks which one to use.
- **Updates:** it keeps itself up to date. For the beta, run the install script with `bash -s beta` or install
  `yellowcode@beta`. See [Usage](docs/usage.md).

> [!TIP]
> We recommend [Ghostty](https://ghostty.org). Images in the chat need a terminal that can draw them, such as Ghostty or
> [kitty](https://sw.kovidgoyal.net/kitty/). Other terminals work too, just without images.

## What you get

With one agent:

- **Paste images.** Paste a screenshot or an image file into the prompt and see it before you send.
- **Images and diagrams in the chat.** Mermaid diagrams, charts and images are drawn, not printed as text.
- **Rewind with your files.** Go back to an earlier message and the project goes back too, whoever changed the files.
  `/redo` undoes it.
- **A calmer chat.** When a turn is done, its tool calls fold into one line.
- **A command palette.** Ctrl+P finds every command, model, session and setting.
- **Mods.** Add your own commands, panes, sidebar sections and tools in TypeScript.

With several:

- **Every model in one picker.** `/model` lists the models of all your providers; pick another provider's and the chat
  moves there.
- **One set of MCP servers.** Add a server once with `yellowcode mcp add` and every provider gets it.
- **One memory.** What the agent learns about your project stays when you switch models.
- **Subagents on any provider.** Hand a task to a Codex model from a Claude Code session and get the answer back.
- **Sessions that work together.** Your open sessions can send each other work, whichever provider each runs.

## Supported providers

| Provider           | Status         |
| ------------------ | -------------- |
| Claude Code        | ✅ Works       |
| Codex CLI          | ✅ Works       |
| opencode           | ✅ Works       |
| Pi                 | ✅ Works       |
| GitHub Copilot CLI | ⏳ In progress |
| Cursor CLI         | ⏳ In progress |

## How it works

YellowCode starts the provider you already use, on your own account, and draws what it sends back. It has no model and
no login of its own, and it never reads your credentials. See [How it works](docs/how-it-works.md).

## FAQ

<details>
<summary>Is YellowCode another coding agent?</summary>

No. It has no model and no login of its own. It runs the provider you already have and gives it a new screen.

</details>

<details>
<summary>Do my settings, MCP servers and skills still work?</summary>

Yes. They belong to your provider and load as usual. Plugins stay off until you turn on Providers' plugins in
`/settings`. To use the same MCP servers with every provider, add them once with `yellowcode mcp add`.

</details>

<details>
<summary>Does it work on Windows?</summary>

Run it inside WSL. It works there the same way it does on Linux.

</details>

<details>
<summary>Who is behind it?</summary>

YellowCode is made by [Arda Sarı](https://github.com/ardasarico) as an independent open-source project. It is not
affiliated with the companies that make the agents.

</details>

## Contributing

Found a bug or want something new? Open an [issue](https://github.com/ardasarico/YellowCode/issues/new/choose). To work
on the code, see [Contributing](CONTRIBUTING.md).

## License

[GPL-3.0](LICENSE).
