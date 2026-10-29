// An isolated root for one Codex run: its own HOME, XDG folders and CODEX_HOME, a seeded git project and a config
// that points a custom provider at the mock. Nothing here reads or writes the user's own Codex files.
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export const MODEL = "gpt-5.5"

export type Root = {
  root: string
  home: string
  codex: string
  project: string
}

const SEED: Record<string, string> = {
  "README.md": "# demo\n\nA small project for Codex recordings.\n",
  "src/a.ts": 'export const greeting = "hello"\n',
}

// Fixed author and dates so the seed commit, and what Codex derives from it, is the same on every run.
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "YellowCode Test",
  GIT_AUTHOR_EMAIL: "test@yellowcode.invalid",
  GIT_COMMITTER_NAME: "YellowCode Test",
  GIT_COMMITTER_EMAIL: "test@yellowcode.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
}

function git(cwd: string, ...args: string[]): void {
  const run = spawnSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" })
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`)
}

export async function makeRoot(name: string, files: Record<string, string | Uint8Array> = {}): Promise<Root> {
  const root = await realpath(await mkdtemp(`/private/tmp/yc-cx-${name}-`))
  const dirs = { home: join(root, "home"), codex: join(root, "codex"), project: join(root, "project") }
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })))
  await Promise.all(
    Object.entries({ ...SEED, ...files }).map(async ([path, content]) => {
      await mkdir(dirname(join(dirs.project, path)), { recursive: true })
      await writeFile(join(dirs.project, path), content)
    }),
  )
  git(dirs.project, "init", "-q", "-b", "main")
  git(dirs.project, "add", ".")
  git(dirs.project, "commit", "-q", "-m", "seed")
  return { root, ...dirs }
}

// A catalog model id, so efforts and the context window are Codex's real ones. No retries unless a scenario asks for
// them. `extras` is TOML appended as is; `top` holds keys that go before the first table.
export async function writeConfig(
  root: Root,
  mockUrl: string,
  extras = "",
  retries = { request: 0, stream: 0 },
  top = "",
): Promise<void> {
  const config = [
    `model = "${MODEL}"`,
    `model_provider = "mock"`,
    top,
    "",
    "[model_providers.mock]",
    `name = "Mock"`,
    `base_url = "${mockUrl}"`,
    `wire_api = "responses"`,
    `request_max_retries = ${retries.request}`,
    `stream_max_retries = ${retries.stream}`,
    "",
    `[projects."${root.project}"]`,
    `trust_level = "trusted"`,
    "",
    extras,
  ]
  await writeFile(join(root.codex, "config.toml"), config.join("\n"))
}

// The only variables of this process app-server gets; serverEnv supplies the rest.
const KEPT = /^(PATH|LANG|LC_\w+|TERM|TMPDIR|USER|LOGNAME)$/

// Outbound HTTP goes to `proxy`, which refuses it, instead of leaving the machine.
export function serverEnv(root: Root, proxy: string): Record<string, string> {
  const kept = Object.entries(process.env).filter(
    (entry): entry is [string, string] => KEPT.test(entry[0]) && entry[1] !== undefined,
  )
  return {
    ...Object.fromEntries(kept),
    HOME: root.home,
    XDG_CONFIG_HOME: join(root.home, ".config"),
    XDG_DATA_HOME: join(root.home, ".local", "share"),
    XDG_STATE_HOME: join(root.home, ".local", "state"),
    XDG_CACHE_HOME: join(root.home, ".cache"),
    CODEX_HOME: root.codex,
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    all_proxy: proxy,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    GIT_CONFIG_NOSYSTEM: "1",
    SHELL: "/bin/bash",
  }
}
