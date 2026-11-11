import { expect, test } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { moveHome, moveLines } from "./move-home.ts"
import { sessionsDir, yellowcodeHome } from "./paths.ts"

function put(path: string, text = "x"): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const read = (path: string) => readFileSync(path, "utf8")
const newHome = () => mkdtempSync(join(tmpdir(), "move-home-"))

const refusedMod: typeof renameSync = (from, to) => {
  if (String(from).endsWith("one")) throw Object.assign(new Error("no"), { code: "EACCES" })
  renameSync(from, to)
}
const crossDevice: typeof renameSync = () => {
  throw Object.assign(new Error("cross-device"), { code: "EXDEV" })
}

// The folders 0.4.0 wrote, under `config`, `data` and `cache`.
function oldLayout(config: string, data: string, cache: string): void {
  put(join(config, "settings.json"), "old settings")
  put(join(config, "state.json"))
  put(join(config, "mods", "one", "index.ts"))
  put(join(config, "themes", "mine.json"))
  put(join(config, ".DS_Store"))
  put(join(data, "snapshots", "-project", "git", "HEAD"))
  put(join(cache, "mods.json"))
  put(join(cache, "update.json"))
}

function movedLayout(root: string): void {
  expect(read(join(root, "settings.json"))).toBe("old settings")
  expect(existsSync(join(root, "state.json"))).toBe(true)
  expect(existsSync(join(root, "mods", "one", "index.ts"))).toBe(true)
  expect(existsSync(join(root, "themes", "mine.json"))).toBe(true)
  expect(existsSync(join(root, "snapshots", "-project", "git", "HEAD"))).toBe(true)
  expect(readdirSync(join(root, "cache")).toSorted()).toEqual(["mods.json", "update.json"])
}

test("a fresh machine gets the marker and no message", () => {
  const home = newHome()
  const result = moveHome({ env: {}, home })
  expect(result).toEqual({ root: join(home, ".yellowcode"), moved: 0, left: [] })
  expect(moveLines(result, home)).toEqual([])
  expect(readdirSync(join(home, ".yellowcode"))).toEqual(["moved.json"])
})

test("the old folders move in, are removed, and never move again", () => {
  const home = newHome()
  const root = join(home, ".yellowcode")
  put(join(root, "models.json"), "kept")
  oldLayout(
    join(home, ".config", "yellowcode"),
    join(home, ".local", "share", "yellowcode"),
    join(home, ".cache", "yellowcode"),
  )
  const result = moveHome({ env: {}, home })
  expect(moveLines(result, home)).toEqual(["Your settings and data moved to ~/.yellowcode"])
  movedLayout(root)
  expect(read(join(root, "models.json"))).toBe("kept")
  for (const gone of [".config/yellowcode", ".local/share/yellowcode", ".cache/yellowcode"])
    expect(existsSync(join(home, gone))).toBe(false)
  expect(existsSync(join(home, ".config"))).toBe(true)

  // An older version still running writes its settings to the old folder again.
  put(join(home, ".config", "yellowcode", "settings.json"), "late write")
  expect(moveHome({ env: {}, home })).toBeNull()
  expect(read(join(root, "settings.json"))).toBe("old settings")
  expect(read(join(home, ".config", "yellowcode", "settings.json"))).toBe("late write")
})

test("old folders are found where the XDG variables put them", () => {
  const home = newHome()
  const env = {
    XDG_CONFIG_HOME: join(home, "xdg", "config"),
    XDG_DATA_HOME: join(home, "xdg", "data"),
    XDG_CACHE_HOME: join(home, "xdg", "cache"),
  }
  oldLayout(
    join(env.XDG_CONFIG_HOME, "yellowcode"),
    join(env.XDG_DATA_HOME, "yellowcode"),
    join(env.XDG_CACHE_HOME, "yellowcode"),
  )
  put(join(home, ".config", "yellowcode", "settings.json"), "not the one in use")
  expect(moveHome({ env, home })?.left).toEqual([])
  movedLayout(join(home, ".yellowcode"))
  expect(existsSync(join(env.XDG_CONFIG_HOME, "yellowcode"))).toBe(false)
  expect(existsSync(join(home, ".config", "yellowcode", "settings.json"))).toBe(true)
})

test("what is already in the new folder is kept, and the old entry stays where it was", () => {
  const home = newHome()
  const root = join(home, ".yellowcode")
  const config = join(home, ".config", "yellowcode")
  put(join(root, "settings.json"), "new settings")
  put(join(root, "mods", "one", "index.ts"), "new mod")
  put(join(config, "settings.json"), "old settings")
  put(join(config, "state.json"))
  put(join(config, "mods", "one", "index.ts"), "old mod")
  put(join(config, "mods", "two", "index.ts"))
  const result = moveHome({ env: {}, home })
  expect(result?.left).toEqual([config])
  expect(moveLines(result, home)).toEqual([
    "Your settings and data moved to ~/.yellowcode",
    "Some files stayed behind in ~/.config/yellowcode",
  ])
  expect(read(join(root, "settings.json"))).toBe("new settings")
  expect(read(join(root, "mods", "one", "index.ts"))).toBe("new mod")
  expect(existsSync(join(root, "mods", "two", "index.ts"))).toBe(true)
  expect(existsSync(join(root, "state.json"))).toBe(true)
  expect(read(join(config, "settings.json"))).toBe("old settings")
  expect(read(join(config, "mods", "one", "index.ts"))).toBe("old mod")
  expect(readdirSync(config).toSorted()).toEqual(["mods", "settings.json"])
})

test("snapshots an older version has open are copied and stay with it", () => {
  const home = newHome()
  const snapshots = join(home, ".local", "share", "yellowcode", "snapshots")
  const other = Bun.spawn(["sleep", "30"])
  put(join(snapshots, "-open", "git", "HEAD"))
  put(join(snapshots, "-open", `index-${other.pid}`, "index"))
  put(join(snapshots, "-closed", "git", "HEAD"))
  const result = moveHome({ env: {}, home })
  other.kill()
  expect(result?.left).toEqual([join(home, ".local", "share", "yellowcode")])
  expect(readdirSync(snapshots)).toEqual(["-open"])
  expect(existsSync(join(snapshots, "-open", "git", "HEAD"))).toBe(true)
  expect(readdirSync(join(home, ".yellowcode", "snapshots")).toSorted()).toEqual(["-closed", "-open"])
  expect(existsSync(join(home, ".yellowcode", "snapshots", "-open", "git", "HEAD"))).toBe(true)
})

test("YELLOWCODE_HOME set: nothing moves and no marker is written", () => {
  const home = newHome()
  const elsewhere = join(home, "elsewhere")
  const config = join(home, ".config", "yellowcode")
  put(join(config, "settings.json"))
  expect(moveHome({ env: { YELLOWCODE_HOME: elsewhere }, home })).toBeNull()
  expect(existsSync(join(config, "settings.json"))).toBe(true)
  expect(existsSync(elsewhere)).toBe(false)
  expect(existsSync(join(home, ".yellowcode"))).toBe(false)
})

test("links inside move as links; a linked old folder is left alone", () => {
  const home = newHome()
  const root = join(home, ".yellowcode")
  const config = join(home, ".config", "yellowcode")
  put(join(home, "dev", "mod", "index.ts"))
  put(join(home, "dotfiles", "themes", "mine.json"))
  put(join(home, "dotfiles", "cache", "mods.json"))
  mkdirSync(join(config, "mods"), { recursive: true })
  symlinkSync(join(home, "dev", "mod"), join(config, "mods", "dev"))
  symlinkSync("../../dotfiles/themes", join(config, "themes"))
  mkdirSync(join(home, ".cache"))
  symlinkSync(join(home, "dotfiles", "cache"), join(home, ".cache", "yellowcode"))

  const result = moveHome({ env: {}, home })
  expect(result?.left).toEqual([join(home, ".cache", "yellowcode")])
  expect(readlinkSync(join(root, "mods", "dev"))).toBe(join(home, "dev", "mod"))
  expect(lstatSync(join(root, "themes")).isSymbolicLink()).toBe(true)
  expect(existsSync(join(root, "themes", "mine.json"))).toBe(true)
  expect(existsSync(join(home, "dev", "mod", "index.ts"))).toBe(true)
  expect(existsSync(config)).toBe(false)
  expect(existsSync(join(home, "dotfiles", "cache", "mods.json"))).toBe(true)
  expect(lstatSync(join(home, ".cache", "yellowcode")).isSymbolicLink()).toBe(true)
  expect(existsSync(join(root, "cache"))).toBe(false)
})

test("a move that fails half-way leaves both sides readable", () => {
  const home = newHome()
  const root = join(home, ".yellowcode")
  const config = join(home, ".config", "yellowcode")
  put(join(config, "a.json"), "a")
  put(join(config, "mods", "one", "index.ts"), "mod")
  put(join(config, "settings.json"), "settings")
  const result = moveHome({ env: {}, home, rename: refusedMod })
  expect(result).toEqual({ root, moved: 2, left: [config] })
  expect(read(join(root, "settings.json"))).toBe("settings")
  expect(read(join(config, "mods", "one", "index.ts"))).toBe("mod")
  expect(existsSync(join(root, "mods", "one"))).toBe(false)
})

test("across filesystems an entry is copied whole, then removed", () => {
  const home = newHome()
  const root = join(home, ".yellowcode")
  const config = join(home, ".config", "yellowcode")
  put(join(config, "mods", "one", "index.ts"), "mod")
  symlinkSync("index.ts", join(config, "mods", "one", "link"))
  expect(moveHome({ env: {}, home, rename: crossDevice })?.left).toEqual([])
  expect(read(join(root, "mods", "one", "index.ts"))).toBe("mod")
  expect(readlinkSync(join(root, "mods", "one", "link"))).toBe("index.ts")
  expect(existsSync(config)).toBe(false)
})

test("a second process waits for the one that is moving, and takes over from a dead one", () => {
  const home = newHome()
  const root = join(home, ".yellowcode")
  put(join(home, ".config", "yellowcode", "settings.json"), "settings")
  put(join(root, "move.lock"), String(process.pid))
  expect(moveHome({ env: {}, home, waitMs: 50 })).toBeNull()
  expect(existsSync(join(root, "settings.json"))).toBe(false)
  expect(existsSync(join(root, "moved.json"))).toBe(false)

  const dead = Bun.spawnSync(["true"]).pid
  writeFileSync(join(root, "move.lock"), String(dead))
  expect(moveHome({ env: {}, home, waitMs: 50 })?.moved).toBe(1)
  expect(existsSync(join(root, "move.lock"))).toBe(false)
})

test("the folder and the sessions folder resolve from YELLOWCODE_HOME", () => {
  expect(yellowcodeHome({}, "/home/u")).toBe("/home/u/.yellowcode")
  expect(yellowcodeHome({ YELLOWCODE_HOME: "" }, "/home/u")).toBe("/home/u/.yellowcode")
  expect(yellowcodeHome({ YELLOWCODE_HOME: "relative" }, "/home/u")).toBe("/home/u/.yellowcode")
  expect(yellowcodeHome({ YELLOWCODE_HOME: "/data/yc", XDG_CONFIG_HOME: "/x" }, "/home/u")).toBe("/data/yc")
  expect(sessionsDir({}, "/home/u")).toBe("/home/u/.yellowcode/sessions")
  const long = sessionsDir({ YELLOWCODE_HOME: `/data/${"long/".repeat(20)}yc` }, "/home/u")
  expect(long).toMatch(/^\/tmp\/yellowcode-\d+-[0-9a-f]{12}$/)
  expect(sessionsDir({ YELLOWCODE_HOME: `/data/${"long/".repeat(20)}yc` }, "/home/u")).toBe(long)
})
