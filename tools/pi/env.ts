// An isolated root for one pi run: its own HOME, XDG folders and PI_CODING_AGENT_DIR, a seeded git project and a
// models.json whose only provider is the mock. Nothing here reads or writes the user's own pi files.
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { TMP } from "../tmp.ts"

export const PROVIDER = "mock"
export const MODEL = "mock-1"

export type Root = {
  root: string
  home: string
  agent: string
  project: string
}

const SEED: Record<string, string> = {
  "README.md": "# demo\n\nA small project for pi recordings.\n",
  "src/a.ts": 'export const greeting = "hello"\n',
}

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
  const root = await realpath(await mkdtemp(`${TMP}/yc-pi-${name}-`))
  const dirs = { home: join(root, "home"), agent: join(root, "agent"), project: join(root, "project") }
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

// A reasoning model with images, so thinking levels and image prompts are pi's real handling of them. The key is a
// placeholder the mock ignores; without one pi does not offer the model.
export async function writeModels(root: Root, mockUrl: string): Promise<void> {
  const models = {
    providers: {
      [PROVIDER]: {
        baseUrl: mockUrl,
        api: "openai-completions",
        apiKey: "mock",
        models: [{ id: MODEL, name: "Mock One", reasoning: true, input: ["text", "image"], contextWindow: 200_000 }],
      },
    },
  }
  await writeFile(join(root.agent, "models.json"), JSON.stringify(models, null, 2))
  await writeFile(
    join(root.agent, "settings.json"),
    JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL, quietStartup: true }, null, 2),
  )
}

const KEPT = /^(PATH|LANG|LC_\w+|TERM|TMPDIR|USER|LOGNAME)$/

// Outbound HTTP goes to `proxy`, which refuses it, instead of leaving the machine.
export function piEnv(root: Root, proxy: string): Record<string, string> {
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
    PI_CODING_AGENT_DIR: root.agent,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
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
