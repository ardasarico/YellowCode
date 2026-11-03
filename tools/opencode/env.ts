// An isolated root for one opencode run: its own HOME and XDG folders, a seeded git project and a config that points
// the anthropic provider at the mock. Nothing here reads or writes the user's own opencode files.
import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { MOCK_KEY } from "../../src/agents/opencode/fixture.ts"
import { TMP } from "../tmp.ts"

export const OPUS = "claude-opus-5-5"
export const HAIKU = "claude-haiku-5-5"

export type Root = {
  root: string
  home: string
  config: string
  data: string
  state: string
  cache: string
  project: string
  // Put first on the service's PATH.
  bin: string
  // Where the isolated service writes its registration.
  registration: string
}

const SEED: Record<string, string> = {
  "README.md": "# demo\n\nA small project for opencode recordings.\n",
  "src/a.ts": 'export const greeting = "hello"\n',
}

// Fixed author and dates so the seed commit, and what opencode derives from it, is the same on every run.
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

export function commitSeed(project: string): void {
  git(project, "add", ".")
  git(project, "commit", "-q", "-m", "seed")
}

export async function makeRoot(
  name: string,
  files: Record<string, string> = {},
  bin: Record<string, string> = {},
  commit = true,
): Promise<Root> {
  const root = await realpath(await mkdtemp(`${TMP}/yc-oc-${name}-`))
  const dirs = {
    home: join(root, "home"),
    config: join(root, "config"),
    data: join(root, "data"),
    state: join(root, "state"),
    cache: join(root, "cache"),
    project: join(root, "project"),
    bin: join(root, "bin"),
  }
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })))
  await Promise.all(
    Object.entries({ ...SEED, ...files }).map(async ([path, content]) => {
      await mkdir(dirname(join(dirs.project, path)), { recursive: true })
      await writeFile(join(dirs.project, path), content)
    }),
  )
  git(dirs.project, "init", "-q", "-b", "main")
  if (commit) commitSeed(dirs.project)
  // The managed service has one fixed port per machine unless its own service.json names another. Without this the
  // isolated service collides with the user's and exits.
  await mkdir(join(dirs.config, "opencode"), { recursive: true })
  await writeFile(join(dirs.config, "opencode", "service.json"), JSON.stringify({ port: freePort() }))
  await Promise.all(Object.entries(bin).map(([file, content]) => writeFile(join(dirs.bin, file), content)))
  const rg = ripgrep()
  if (rg) await symlink(rg, join(dirs.bin, "rg"))
  checkRipgrep(rg && join(dirs.bin, "rg"))
  return { root, ...dirs, registration: join(dirs.state, "opencode", "service.json") }
}

// opencode's glob and grep need ripgrep, which it would download (the proxy stops that). Without an `rg` on PATH the
// claude binary is linked instead: it runs as ripgrep when called by that name (the binary itself, not the launcher
// link). That is undocumented, so a link that does not answer as ripgrep is said plainly.
function ripgrep(): string | null {
  const claude = Bun.which("claude")
  return Bun.which("rg") ?? (claude ? realpathSync(claude) : null)
}

function checkRipgrep(link: string | null): void {
  const answered = link !== null && spawnSync(link, ["--version"], { encoding: "utf8" }).stdout.startsWith("ripgrep")
  if (!answered) console.error("opencode recordings: glob and grep need rg on PATH; they will fail without it")
}

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = server.port
  server.stop(true)
  return port
}

export const model = (name: string) => ({ name, limit: { context: 200000, output: 32000 } })

// The V2 config shape turns-report.md verified. `extras` are merged on top (a scenario's permissions, for one); its
// `providers` go next to anthropic.
export async function writeConfig(root: Root, mockUrl: string, extras: Record<string, unknown> = {}): Promise<void> {
  const { providers, ...rest } = extras
  const config = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    model: `anthropic/${OPUS}`,
    agents: { title: { model: `anthropic/${HAIKU}` } },
    enabled_providers: ["anthropic"],
    providers: {
      anthropic: {
        settings: { apiKey: MOCK_KEY, baseURL: mockUrl },
        models: { [OPUS]: model("Claude Opus 5.5"), [HAIKU]: model("Claude Haiku 5.5") },
      },
      ...(typeof providers === "object" ? providers : {}),
    },
    ...rest,
  }
  const file = join(root.config, "opencode", "opencode.json")
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(config, null, 2))
}

// The only variables of this process the service gets; serviceEnv supplies the rest.
const KEPT = /^(PATH|LANG|LC_\w+|TERM|TMPDIR|USER|LOGNAME)$/

// `ensure` starts the service with this process's env plus its own, so during `start` this process's env holds only
// the kept variables. The rest is put back afterwards.
export async function withServiceEnv<T>(start: () => Promise<T>): Promise<T> {
  const saved = { ...process.env }
  for (const key of Object.keys(process.env)) if (!KEPT.test(key)) delete process.env[key]
  try {
    return await start()
  } finally {
    Object.assign(process.env, saved)
  }
}

// Any outbound fetch (models.dev, updates) goes to a closed port instead of leaving the machine.
export function serviceEnv(root: Root): Record<string, string> {
  return {
    HOME: root.home,
    XDG_CONFIG_HOME: root.config,
    XDG_DATA_HOME: root.data,
    XDG_STATE_HOME: root.state,
    XDG_CACHE_HOME: root.cache,
    PATH: `${root.bin}:${process.env["PATH"] ?? ""}`,
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    http_proxy: "http://127.0.0.1:9",
    https_proxy: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    GIT_CONFIG_NOSYSTEM: "1",
    SHELL: "/bin/bash",
  }
}
