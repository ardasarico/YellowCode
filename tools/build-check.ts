// Builds the binary for this machine and checks that a mod loads with YellowCode's own Solid: bun run build:check
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import packageJson from "../package.json"
import { build, PLATFORMS } from "./build.ts"

const host = PLATFORMS.find((platform) => platform === `${process.platform}-${process.arch}`)
if (!host) throw new Error(`no build target for ${process.platform}-${process.arch}`)

const home = mkdtempSync(join(tmpdir(), "yellowcode-build-check-"))
// The mod is written outside the mods folder, then copied in once and linked in once, the way an author works on one.
const mod = join(home, "work", "probe")
const installed = join(home, "yellowcode", "mods", "probe")
const result = join(home, "result.json")

function write(path: string, text: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true })
  writeFileSync(path, text)
}

// The mod's dependency imports solid-js, and the mod folder holds a solid-js of its own. Both must still get the app's.
write(
  join(mod, "yellowcode-mod.json"),
  JSON.stringify({
    id: "probe",
    name: "Probe",
    version: "1.0.0",
    description: "",
    api: "*",
    agents: "any",
    entry: "index.tsx",
  }),
)
write(
  join(mod, "index.tsx"),
  `import { writeFileSync } from "node:fs"
import { createSignal } from "solid-js"
import { BoxRenderable } from "@opentui/core"
import { defineMod } from "yellowcode/mod"
import { depSignal } from "dep"

const Probe = () => <text>probe</text>

export default defineMod({
  setup() {
    const same = createSignal === depSignal && typeof BoxRenderable === "function" && typeof Probe === "function"
    writeFileSync(${JSON.stringify(result)}, String(same))
    process.exit(0)
  },
})
`,
)
write(join(mod, "node_modules/dep/package.json"), JSON.stringify({ name: "dep", type: "module", main: "index.js" }))
write(join(mod, "node_modules/dep/index.js"), `export { createSignal as depSignal } from "solid-js"\n`)
write(
  join(mod, "node_modules/solid-js/package.json"),
  JSON.stringify({ name: "solid-js", type: "module", main: "index.js" }),
)
write(join(mod, "node_modules/solid-js/index.js"), "export function createSignal() {}\n")

const binary = await build(host, { version: packageJson.version, channel: "stable" })
const replay = resolve(import.meta.dir, "../fixtures/sessions/chat.jsonl")
const command = [binary, "--replay", replay, "--speed", "instant", "--skip-terminal-check"]
// The app needs a terminal; script gives it one.
const tty =
  process.platform === "darwin"
    ? ["script", "-q", "/dev/null", ...command]
    : ["script", "-qec", command.join(" "), "/dev/null"]
async function load(how: "copied" | "linked"): Promise<string | null> {
  rmSync(installed, { recursive: true, force: true })
  rmSync(result, { force: true })
  mkdirSync(resolve(installed, ".."), { recursive: true })
  if (how === "copied") cpSync(mod, installed, { recursive: true })
  else symlinkSync(mod, installed)
  const run = Bun.spawn(tty, {
    env: { ...process.env, XDG_CONFIG_HOME: home, YELLOWCODE_LOG_DIR: join(home, "logs") },
    stdin: Bun.file("/dev/null"),
    stdout: "ignore",
    stderr: "ignore",
  })
  const timer = setTimeout(() => run.kill(), 30_000)
  await run.exited
  clearTimeout(timer)
  try {
    return readFileSync(result, "utf8")
  } catch {
    return null
  }
}

const copied = await load("copied")
const linked = await load("linked")
rmSync(home, { recursive: true, force: true })
for (const [how, same] of [
  ["copied", copied],
  ["linked", linked],
] as const) {
  if (same === "true") continue
  console.error(`${how} mod: ${same === "false" ? "it got a second Solid" : "it did not load in the binary"}`)
  process.exit(1)
}
console.log(`${binary}: a copied and a linked mod loaded with the app's Solid`)
