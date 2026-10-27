# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately on GitHub instead:
[Report a vulnerability](https://github.com/ardasarico/YellowCode/security/advisories/new).

Say what you found, how to reproduce it, and which version you use (`yellowcode --version`). You get a reply within a
week. Once a fix is out, the advisory is published, with credit to you unless you would rather not.

## Supported versions

Only the latest release gets security fixes.

## What to report

- A way to install or run mod code that the mod list has not reviewed without asking the user, or to get past the
  list's hash check.
- Rewind, or any other part of YellowCode, writing or deleting files it should not.
- YellowCode reading your credentials, or sending your prompts, files or sessions anywhere but to your agent.
- The install script or a release download doing anything other than installing YellowCode.

## What not to report here

- What a mod you chose to install does. Mods run with your permissions; see [Mods](docs/mods.md). A listed mod that
  breaks the [listing rules](docs/mod-api.md#getting-a-mod-listed) is worth reporting, though.
- A problem in your agent itself. Report that to the agent's maker.
