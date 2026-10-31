# Contributing

Thanks for helping. Bug reports, fixes and new mods are all welcome.

## Reporting a bug

Open a [bug report](https://github.com/ardasarico/YellowCode/issues/new?template=bug.yml). The form asks for what
`yellowcode --report` prints, so have that ready.

## Before you start

For a bug fix, open a pull request. For a new feature or a bigger change, open a
[feature request](https://github.com/ardasarico/YellowCode/issues/new?template=feature.yml) first so we can agree on it
before you spend time on code.

## Setting up

You need [Bun](https://bun.sh) and a supported agent, installed and logged in.

```sh
git clone https://github.com/ardasarico/YellowCode
cd YellowCode
bun install
bun run dev
```

`bun run dev` starts YellowCode in the repo folder. To try it in another project, run `bin/yellowcode` from there.

### Without an agent

The repo has recorded Claude Code sessions in `fixtures/sessions/`. A replay plays one back without starting the
agent, so it needs no login and costs nothing:

```sh
bun run dev --replay fixtures/sessions/chat.jsonl
```

Enter sends the next recorded message or answer. `--speed <number|instant>` changes the playback speed. Ctrl+C twice
quits.

## Making a change

- Write everything in English: code, comments, docs and commit messages.
- Keep code plain. Add a comment only when the code cannot explain itself.
- Add tests where they guard a real risk, and keep them small.
- Run `bun run check` before you push. It runs the type check, lint, format check, the mod API types check and the
  tests.
- If you change the mod API, run `bun run types` and update [the Mod API guide](docs/mod-api.md).

What passes between YellowCode and an agent is not a public API, so a change that reads or sends new messages needs a
recorded session that shows them.

- Claude Code: the scenarios are in `tools/record/scenarios.ts`. Add one there and run `bun run record <name>`. This
  runs a live `claude` on your account.
- Codex and opencode: the scenarios are in `tools/codex/scenarios/` and `tools/opencode/scenarios/`. Add one there and
  run `bun tools/codex/record.ts <name>` or `bun tools/opencode/record.ts <name>`. These run your installed `codex`, or
  `opencode` from `~/.opencode/bin`, in a throwaway home against a local stand-in for the model API, so they need no
  login and cost nothing. The recordings go to `fixtures/codex/` and `fixtures/opencode/`. `--check` records again and
  compares the result with the committed one.

Tests compare replays of these recordings with the expected results in `fixtures/goldens/`. When a change alters them
on purpose, run the tests with `UPDATE_GOLDENS=1` (Claude Code), `UPDATE_CODEX_GOLDENS=1` or `UPDATE_OPENCODE_GOLDENS=1`
to write them again, and read the diff before you commit.

## Commits and pull requests

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`, for
example `fix(ui): keep the sidebar width after a resize`. Keep to the subject line, and add at most one short sentence
of body.

Keep a pull request to one change. Say what it fixes or adds, and how you checked it.

## Mods

To get a mod on the mod list, see [Getting a mod listed](docs/mod-api.md#getting-a-mod-listed).

## License

By contributing, you agree that your work is released under the [GPL-3.0](LICENSE), the same license as the project.
