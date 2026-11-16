<!-- For adding or updating a mod on the list. See docs/mod-api.md#getting-a-mod-listed. -->

**Mod repo:** https://github.com/OWNER/REPO

**Review link:** <!-- The link the Mods check prints for your entry once it passes. -->

This pull request changes only `mods.json`, and the mod:

- [ ] Does not load code from the network: everything it runs is in the listed commit or in its locked dependencies.
- [ ] Does not update itself.
- [ ] Has no minified or obfuscated source.
- [ ] Has a `bun.lock` if it has a `package.json`, and works with its dependencies installed without scripts.
- [ ] Runs only files inside the mod, or packages pinned to an exact version, in its `mcpServers`.
- [ ] Has `solid-js`, `@opentui/*` and `yellowcode` only as peer dependencies, and `@yellowcode/mod` only as a dev
      dependency.
