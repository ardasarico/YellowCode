import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EnsureOptions } from "@opencode/client/service"
import { findService, type ServiceClient } from "./service.ts"

const ENDPOINT = {
  url: "http://127.0.0.1:4100",
  auth: { type: "basic" as const, username: "opencode", password: "pw" },
}
const QUICK = { totalMs: 30, pollMs: 5 }

let state = ""
const saved = { XDG_STATE_HOME: process.env["XDG_STATE_HOME"], NO_PROXY: process.env["NO_PROXY"] }
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "yc-oc-service-"))
  process.env["XDG_STATE_HOME"] = state
  process.env["NO_PROXY"] = "example.com"
})
afterEach(() => {
  rmSync(state, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function register(pid: number, url: string): void {
  mkdirSync(join(state, "opencode"), { recursive: true })
  writeFileSync(join(state, "opencode", "service.json"), JSON.stringify({ pid, url, password: "pw" }))
}

// A port that accepts connections and never answers, like a service that hangs.
function hanging(): { url: string; close(): void } {
  const server = createServer(() => {}).listen(0, "127.0.0.1")
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("no port")
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() }
}

// A port nothing listens on.
function refused(): string {
  const server = createServer().listen(0, "127.0.0.1")
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("no port")
  server.close()
  return `http://127.0.0.1:${address.port}`
}

function client(found: (typeof ENDPOINT | undefined)[], fails = false) {
  const ensured: EnsureOptions[] = []
  const versions: boolean[] = []
  const proxies: (string | undefined)[] = []
  const fake: ServiceClient = {
    discover(options) {
      proxies.push(process.env["NO_PROXY"])
      if (typeof options?.version === "function") versions.push(options.version("0.0.1"))
      return Promise.resolve(found.shift())
    },
    ensure(options) {
      ensured.push(options ?? {})
      return fails ? Promise.reject(new Error("exited\nserver password secret")) : Promise.resolve(ENDPOINT)
    },
  }
  return { fake, ensured, versions, proxies }
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => "",
    (error: unknown) => String(error),
  )

test("a registered service that answers is used as it is, whatever its version", async () => {
  const { fake, ensured, versions, proxies } = client([ENDPOINT])
  expect(await findService("/bin/opencode", fake, QUICK)).toEqual(ENDPOINT)
  expect(ensured).toEqual([])
  expect(versions).toEqual([true])
  // Loopback is kept off the user's proxy for the call only.
  expect(proxies).toEqual(["example.com,127.0.0.1,localhost,::1"])
  expect(process.env["NO_PROXY"]).toBe("example.com")
  expect(process.env["no_proxy"]).toBeUndefined()
})

test("with no service running, one is started at the default registration with the user's env", async () => {
  register(2 ** 22 + 12345, ENDPOINT.url)
  const { fake, ensured } = client([undefined])
  expect(await findService("/bin/opencode", fake, QUICK)).toEqual(ENDPOINT)
  expect(ensured).toHaveLength(1)
  const options = ensured[0] ?? {}
  expect(options.command).toEqual(["/bin/opencode", "serve", "--service"])
  expect(options.file).toBeUndefined()
  // The started service keeps the user's proxy settings, not the ones changed for the call.
  expect(options.env).toEqual({ NO_PROXY: "example.com", no_proxy: "" })
  expect(typeof options.version === "function" && options.version("9.9.9")).toBe(true)
  // A start that would stop the registered service to replace it is refused.
  expect(() => options.onStart?.("version-mismatch", "2.1.0")).toThrow()
  expect(() => options.onStart?.("missing")).not.toThrow()
})

test("a service that runs but does not answer is waited for, never replaced", async () => {
  const port = hanging()
  try {
    register(process.pid, port.url)
    const late = client([undefined, undefined, ENDPOINT])
    expect(await findService("/bin/opencode", late.fake, QUICK)).toEqual(ENDPOINT)
    const silent = client([])
    expect(await failure(findService("/bin/opencode", silent.fake, QUICK))).toContain("does not answer")
    expect([...late.ensured, ...silent.ensured]).toEqual([])
  } finally {
    port.close()
  }
})

test("a registration whose pid was reused but whose port is closed does not block a start", async () => {
  register(process.pid, refused())
  const { fake, ensured } = client([undefined])
  expect(await findService("/bin/opencode", fake, QUICK)).toEqual(ENDPOINT)
  expect(ensured).toHaveLength(1)
})

test("a service that fails to start gives a fixed error, never its output", async () => {
  const { fake } = client([undefined], true)
  const failed = await failure(findService("/bin/opencode", fake, QUICK))
  expect(failed).toContain("did not start")
  expect(failed).not.toContain("secret")
})

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : files(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

test("nothing imports the client's stop, so YellowCode never stops the user's service", () => {
  const root = join(import.meta.dir, "..", "..", "..")
  const importers = [...files(join(root, "src")), ...files(join(root, "tools"))].flatMap((path) => {
    const text = readFileSync(path, "utf8")
    return [...text.matchAll(/import\s+([^;]*?)\s+from\s+["']@opencode\/client[^"']*["']/g)].map((match) => ({
      path,
      names: match[1] ?? "",
    }))
  })
  expect(importers.length).toBeGreaterThan(0)
  for (const { path, names } of importers) {
    expect([path, /\bstop\b|\bService\b|\*/.test(names)]).toEqual([path, false])
  }
})
