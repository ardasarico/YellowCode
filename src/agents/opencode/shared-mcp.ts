// The shared MCP servers YellowCode hands opencode, and the user's own servers a session leaves off. opencode keeps both
// per folder in its running service, for every client there (the user's own opencode screen too), until the service
// restarts or reloads the folder. The sessions of one YellowCode in a folder share what was done there, so one that
// closes undoes only what no other one still needs. Each YellowCode keeps the names of what it did in a record on disk,
// so a later one undoes what a YellowCode that is gone left, and never takes it for the user's own.
import { randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { McpLaunch, OwnMcp } from "../../agent/agent.ts"
import type { Outcome } from "../../agent/ids.ts"
import { parseJson } from "../../json.ts"
import { log } from "../../log/log.ts"
import { withoutServerValues } from "../../source/safe-text.ts"
import { OWN_SERVER } from "./own-mcp.ts"
import type { Query, Transport } from "./transport.ts"
import { answerOf, dataOf, rawPage } from "./wire/envelope.ts"

// YellowCode's own, and the mods' servers a YellowCode handed in this folder: never the user's.
const isYellowCode = (name: string) => name === OWN_SERVER || name.startsWith("mod-")

export type Config = { config: Record<string, unknown> } | { problem: string }

// opencode's config for one server. A remote one with headers carries its own sign-in, so opencode's OAuth stays out of
// it; one without keeps opencode's sign-in flow.
export function configOf(server: McpLaunch): Config {
  if ("command" in server)
    return {
      config: {
        type: "local",
        command: [server.command, ...server.args],
        ...(Object.keys(server.env).length > 0 && { environment: server.env }),
        ...(server.cwd !== undefined && { cwd: server.cwd }),
      },
    }
  if (server.type === "sse")
    return { problem: `opencode cannot connect to an SSE server, so ${server.name} is off here.` }
  const signed = Object.keys(server.headers).length > 0
  return { config: { type: "remote", url: server.url, ...(signed && { headers: server.headers, oauth: false }) } }
}

// opencode's words about a refused server, without the server's secrets, command line or url path.
function problemOf(server: McpLaunch, said: string | null): string {
  return said ? withoutServerValues(said, [server]) : `opencode did not take ${server.name}.`
}

const listed = dataOf(z.array(z.looseObject({ name: z.string(), status: z.looseObject({ status: z.string() }) })))

// Every server of the folder by name, with its status; null when opencode did not answer.
async function listOf(transport: Transport): Promise<Map<string, string> | null> {
  const reply = await transport.request({ method: "GET", path: "/api/mcp" }).catch(() => null)
  const answer = reply ? answerOf(reply, listed, "MCP servers") : null
  if (answer?.kind !== "ok") return null
  return new Map(answer.value.data.map((row) => [row.name, row.status.status]))
}

// opencode reads a folder's servers a moment after its first request there, and lists none until then. Its agents
// list answers once the folder has loaded, so the servers are read after it.
async function loadedList(transport: Transport): Promise<Map<string, string>> {
  await transport.request({ method: "GET", path: "/api/agent" }).catch(() => null)
  return (await listOf(transport)) ?? new Map()
}

// The servers of the folder's config files. The list cannot tell them from added ones, and still names a file's
// server that was removed until the folder reloads; the config does not. Only the names are kept: the rest holds
// commands, environments and headers. Null when opencode did not answer.
const documents = z.array(
  z.looseObject({
    info: z
      .looseObject({ mcp: z.looseObject({ servers: z.record(z.string(), z.unknown()) }).optional() })
      .optional()
      .catch(undefined),
  }),
)

async function fileServers(transport: Transport): Promise<Set<string> | null> {
  const reply = await transport.request({ method: "GET", path: "/api/config" }).catch(() => null)
  const answer = reply ? answerOf(reply, z.union([documents, dataOf(documents)]), "config") : null
  if (answer?.kind !== "ok") return null
  const rows = Array.isArray(answer.value) ? answer.value : answer.value.data
  return new Set(rows.flatMap((row) => Object.keys(row.info?.mcp?.servers ?? {})))
}

const PAGE = "50"
const MAX_PAGES = 20
const sessionTime = z.looseObject({ time: z.looseObject({ busy: z.number().optional(), idle: z.number().optional() }) })

// Whether a session of the folder runs a turn, in any client; true when opencode does not say.
async function busyIn(transport: Transport, folder: string): Promise<boolean> {
  let query: Query = { directory: folder, limit: PAGE }
  for (let count = 0; count < MAX_PAGES; count++) {
    // oxlint-disable-next-line no-await-in-loop -- each page names the next
    const reply = await transport.request({ method: "GET", path: "/api/session", query }).catch(() => null)
    const answer = reply ? answerOf(reply, rawPage, "sessions") : null
    if (answer?.kind !== "ok") return true
    const busy = answer.value.data.some((row) => {
      const time = sessionTime.safeParse(row).data?.time
      return time?.busy !== undefined && (time.idle ?? 0) < time.busy
    })
    if (busy) return true
    const cursor = answer.value.cursor.next
    if (!cursor || answer.value.data.length < Number(PAGE)) return false
    query = { cursor, limit: PAGE }
  }
  return true
}

const serverPath = (name: string) => `/api/experimental/mcp/${encodeURIComponent(name)}`

async function call(transport: Transport, method: "PUT" | "POST" | "DELETE", path: string, body?: unknown) {
  const reply = await transport.request({ method, path, body }).catch(() => null)
  return reply ? answerOf(reply, z.unknown(), "MCP server") : null
}

// One folder of one service in a record: names only, never a server's config.
const ENTRY = z.object({
  service: z.string(),
  folder: z.string(),
  handed: z.array(z.string()),
  // Of `handed`, the names that took the place of one of the user's own.
  replaced: z.array(z.string()),
  // The user's own servers switched off.
  off: z.array(z.string()),
})
const RECORD = z.object({ pid: z.number().int(), entries: z.array(ENTRY) })

export type Entry = z.infer<typeof ENTRY>
type Stored = { file: string; pid: number; entries: Entry[]; at: number }

// A pid may be used again by a later YellowCode, so each process writes its own file.
const recordName = `${process.pid}-${randomBytes(4).toString("hex")}.json`

function readRecords(dir: string): Stored[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json") && name !== recordName)
  } catch {
    return []
  }
  return names.flatMap((name) => {
    const file = join(dir, name)
    let text: string
    let at: number
    try {
      text = readFileSync(file, "utf8")
      at = statSync(file).mtimeMs
    } catch {
      return []
    }
    const json = parseJson(text)
    const parsed = json.ok ? RECORD.safeParse(json.value) : null
    return parsed?.success ? [{ file, pid: parsed.data.pid, entries: parsed.data.entries, at }] : []
  })
}

function writeRecord(dir: string, file: string, pid: number, entries: Entry[]): void {
  if (entries.length === 0) return rmSync(file, { force: true })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify({ pid, entries }), { mode: 0o600 })
  renameSync(temp, file)
}

function keepRecord(dir: string, file: string, pid: number, entries: Entry[]): void {
  try {
    writeRecord(dir, file, pid, entries)
  } catch (error) {
    log.warn("opencode: the record of the shared MCP servers was not written", String(error))
  }
}

// A record of a YellowCode that is gone this long names a service or folder no one opens again.
const STALE_MS = 30 * 24 * 60 * 60 * 1000

// The other YellowCodes' entries for one folder of one service: of those still open, and of those gone.
export type Found = { live: Entry[]; gone: (Entry & { file: string })[] }

function foundIn(dir: string, live: ReadonlySet<number>, service: string, folder: string): Found {
  const found: Found = { live: [], gone: [] }
  for (const stored of readRecords(dir)) {
    const open = stored.pid !== process.pid && live.has(stored.pid)
    if (!open && Date.now() - stored.at > STALE_MS) {
      keepRecord(dir, stored.file, stored.pid, [])
      continue
    }
    for (const entry of stored.entries) {
      if (entry.service !== service || entry.folder !== folder) continue
      if (open) found.live.push(entry)
      else found.gone.push({ ...entry, file: stored.file })
    }
  }
  return found
}

// Names other YellowCodes handed that took no one's place: never the user's own.
export function foreignOf(found: Found): Set<string> {
  const all = [...found.live, ...found.gone]
  const replaced = new Set(all.flatMap((entry) => entry.replaced))
  return new Set(all.flatMap((entry) => entry.handed).filter((name) => !replaced.has(name)))
}

export type Sweep = {
  // Left by a YellowCode that is gone: added servers to remove, and servers over the user's own of their name, which
  // only a reload of the folder takes away again.
  remove: string[]
  restore: string[]
  // The user's own a YellowCode that is gone switched off.
  reconnect: string[]
}

// What YellowCodes that are gone left in the folder. Nothing another open session of ours holds, or that is handed
// now, counts; `ours` is this process's other sessions in the folder. A recorded name of a server in the folder's
// config files that took no one's place is a wrong record, and the user's server stays.
export function sweepOf(
  found: Found,
  list: ReadonlyMap<string, string>,
  handing: ReadonlySet<string>,
  ours: { handed: ReadonlySet<string>; off: ReadonlySet<string> },
  ownOn: boolean,
  files: ReadonlySet<string>,
): Sweep {
  const held = new Set([...ours.handed, ...found.live.flatMap((entry) => entry.handed)])
  const kept = new Set([...ours.off, ...found.live.flatMap((entry) => entry.off)])
  const replaced = new Set(found.gone.flatMap((entry) => entry.replaced))
  const left = new Set(
    found.gone
      .flatMap((entry) => entry.handed)
      .filter((name) => list.has(name) && !handing.has(name) && !held.has(name)),
  )
  const reconnect = ownOn
    ? new Set(
        found.gone
          .flatMap((entry) => entry.off)
          .filter((name) => list.get(name) === "disabled" && !kept.has(name) && !handing.has(name)),
      )
    : new Set<string>()
  return {
    remove: [...left].filter((name) => !replaced.has(name) && !files.has(name)),
    restore: [...left].filter((name) => replaced.has(name)),
    reconnect: [...reconnect],
  }
}

const same = (a: Entry, b: Entry) => a.service === b.service && a.folder === b.folder

// Takes one folder of one service out of the records of YellowCodes that are gone, but for the names still `left`
// there. A record left with nothing is removed.
function forget(gone: Found["gone"], dir: string, left: ReadonlySet<string> = new Set()): void {
  const files = new Set(gone.map((entry) => entry.file))
  for (const stored of readRecords(dir)) {
    if (!files.has(stored.file)) continue
    const rest = stored.entries.flatMap((entry): Entry[] => {
      if (!gone.some((one) => one.file === stored.file && same(one, entry))) return [entry]
      const handed = entry.handed.filter((name) => left.has(name))
      const replaced = entry.replaced.filter((name) => left.has(name))
      return handed.length > 0 ? [{ ...entry, handed, replaced, off: [] }] : []
    })
    keepRecord(dir, stored.file, stored.pid, rest)
  }
}

const reload = (transport: Transport) => call(transport, "POST", "/api/location/reload")

type Holder = {
  // The servers this session handed, by name, and the user's own it switched off.
  handed: Map<string, McpLaunch>
  off: Set<string>
  // Taken off mid-session and not removed yet.
  leaving: Set<string>
}

type Folder = {
  service: string
  // The user's own servers of the folder, as first read; null until read, and after the service lost what was done.
  own: Set<string> | null
  holders: Set<Holder>
  // Servers over one of the user's own that no session needs any more, waiting for a reload of the folder.
  left: Set<string>
  // What sessions do here goes one at a time.
  work: Promise<unknown>
}

const folders = new Map<string, Folder>()

// This process's record, from what its sessions hold now.
function save(dir: string): void {
  const entries = [...folders.entries()].flatMap(([folder, state]): Entry[] => {
    const handed = new Set<string>()
    const off = new Set<string>()
    for (const holder of state.holders) {
      for (const name of [...holder.handed.keys(), ...holder.leaving]) handed.add(name)
      for (const name of holder.off) off.add(name)
    }
    for (const name of state.left) handed.add(name)
    if (handed.size === 0 && off.size === 0) return []
    const replaced = [...handed].filter((name) => state.own?.has(name) ?? false)
    return [{ service: state.service, folder, handed: [...handed], replaced, off: [...off] }]
  })
  keepRecord(dir, join(dir, recordName), process.pid, entries)
}

export type SharedDeps = {
  transport(): Transport
  // The folder opencode keeps the servers for: the transport's.
  folder: string
  // The service, as its origin.
  service(): string
  held(name: string, problem: string): void
  // A handed server took the place of one of the folder's own of its name.
  replaced(name: string): void
  // Where each YellowCode keeps its record, and the pids of the YellowCode sessions open now.
  records: string
  live(): ReadonlySet<number>
}

export type SharedMcp = {
  // Settles once the servers were handed at the start.
  ready: Promise<void>
  // For /mcp: the names that were the user's own before any server was handed, and the names handed.
  marks(): { own: ReadonlySet<string>; handed: ReadonlySet<string> }
  // Mid-session: the shared servers from now on.
  set(servers: readonly McpLaunch[], ownMcp?: OwnMcp): Promise<Outcome>
  // After the stream connected again or the folder's servers changed: hands everything over again if opencode lost it.
  // A change tells only by an added server that is gone, as the user may turn one of theirs on again. After a reload
  // of the folder, at `at`, everything is handed again, unless a hand read the folder after it.
  check(why: "connected" | "changed" | "reloaded", at?: number): void
  // The user turned a server on or off in /mcp: one of theirs turned on stays on.
  toggled(name: string, on: boolean): void
  close(): Promise<void>
}

export function startSharedMcp(deps: SharedDeps, servers: readonly McpLaunch[], ownMcp: OwnMcp | undefined): SharedMcp {
  const folder = folders.get(deps.folder) ?? {
    service: deps.service(),
    own: null,
    holders: new Set(),
    left: new Set(),
    work: Promise.resolve(),
  }
  folders.set(deps.folder, folder)
  const holder: Holder = { handed: new Map(), off: new Set(), leaving: new Set() }
  folder.holders.add(holder)
  let wanted = [...servers]
  let leaveOff = ownMcp?.on === false
  let closed = false
  let checking = false
  // When the last hand of everything read the folder: a reload before it, this session's own too, is handled.
  let readAt = 0

  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    const done = folder.work.then(work)
    folder.work = done.catch(() => {})
    return done
  }

  const others = () => [...folder.holders].filter((one) => one !== holder)
  const found = () => foundIn(deps.records, deps.live(), folder.service, deps.folder)

  // A reload of the folder drops the servers of every client there, and is not issued while another YellowCode holds
  // some or a session there runs a turn. What it would bring back waits on record for the next start or close.
  async function reloaded(transport: Transport, why: string, names: readonly string[]): Promise<boolean> {
    if (found().live.length > 0 || (await busyIn(transport, deps.folder))) {
      log.info("opencode: the folder is in use, so the user's own MCP servers come back later", names)
      return false
    }
    log.info(`opencode: reloading the folder to give the user's own MCP servers back (${why})`, names)
    const done = await reload(transport)
    if (done?.kind !== "ok") return false
    folder.left.clear()
    return true
  }

  // Of the servers waiting for a reload, those no session holds again.
  const waiting = (handing: ReadonlySet<string> = new Set()) =>
    [...folder.left].filter(
      (name) => !handing.has(name) && ![...folder.holders].some((one) => one.handed.has(name) || one.leaving.has(name)),
    )

  async function handAll(): Promise<void> {
    const at = Date.now()
    await hand(await loadedList(deps.transport()), true)
    readAt = at
  }

  // The user's own are what the folder lists, but for the servers a YellowCode added: on a first read, or once
  // opencode lost what was done (`fresh`), when other sessions may have handed theirs again already.
  function ownOf(list: Map<string, string>, fresh: boolean, foreign: ReadonlySet<string>): Set<string> {
    if (folder.own !== null && !fresh) return folder.own
    const before = folder.own ?? new Set<string>()
    const ours = new Set<string>()
    for (const one of folder.holders) for (const name of one.handed.keys()) if (!before.has(name)) ours.add(name)
    folder.own = new Set(
      [...list.keys()].filter((name) => !isYellowCode(name) && !ours.has(name) && !foreign.has(name)),
    )
    return folder.own
  }

  async function hand(list: Map<string, string>, fresh = false, foreign = foreignOf(found())): Promise<void> {
    const transport = deps.transport()
    folder.service = deps.service()
    const own = ownOf(list, fresh, foreign)
    const names = new Set(wanted.map((server) => server.name))
    const configs = wanted.map((server) => ({ server, config: configOf(server) }))
    const offNow = leaveOff ? [...own].filter((name) => !names.has(name)) : []
    for (const name of offNow) holder.off.add(name)
    for (const { server, config } of configs) if ("config" in config) holder.handed.set(server.name, server)
    // On record before opencode has them, so a YellowCode that ends now still leaves them on record.
    save(deps.records)
    const off = async (name: string) => {
      holder.off.add(name)
      if (list.get(name) === "disabled") return
      const done = await call(transport, "POST", `${serverPath(name)}/disconnect`)
      if (done?.kind !== "ok") log.warn("opencode: an MCP server did not go off", name)
    }
    await Promise.all(offNow.map(off))
    // opencode answers a PUT once the server has started or given up on it, which can take half a minute.
    await Promise.all(
      configs.map(async ({ server, config }) => {
        const answer = "config" in config ? await call(transport, "PUT", serverPath(server.name), config) : null
        if (answer?.kind === "ok") {
          if (own.has(server.name)) deps.replaced(server.name)
          return
        }
        holder.handed.delete(server.name)
        const problem =
          "problem" in config
            ? config.problem
            : problemOf(server, answer?.kind === "error" ? answer.message : "opencode did not answer.")
        log.warn("opencode: shared MCP server held", { name: server.name, problem })
        deps.held(server.name, problem)
        // A held server's own namesake goes off with it.
        if (own.has(server.name)) await off(server.name)
      }),
    )
    save(deps.records)
  }

  // At the start: what YellowCodes that are gone left in the folder is undone first, then this session's servers are
  // handed.
  async function start(before: Found): Promise<void> {
    const transport = deps.transport()
    let at = Date.now()
    let list = await loadedList(transport)
    const ours = { handed: new Set<string>(), off: new Set<string>() }
    for (const one of others()) {
      for (const name of one.handed.keys()) ours.handed.add(name)
      for (const name of one.off) ours.off.add(name)
    }
    const handing = new Set(wanted.map((server) => server.name))
    // Without the config files nothing left is removed: a name on record might be the user's.
    const files = await fileServers(transport)
    const sweep = sweepOf(before, list, handing, ours, !leaveOff, files ?? new Set())
    const remove = files === null ? [] : sweep.remove
    const left = new Set(files === null ? sweep.remove : [])
    const restore = [...sweep.restore, ...waiting(handing)]
    let fresh = false
    // Only a reload brings the user's own back; it drops every added server too, so the other sessions here hand
    // theirs again once they hear of it.
    if (restore.length > 0 && (await reloaded(transport, "start", restore))) {
      at = Date.now()
      list = await loadedList(transport)
      fresh = true
      left.clear()
    } else {
      for (const name of sweep.restore) left.add(name)
      for (const name of remove) {
        // oxlint-disable-next-line no-await-in-loop -- one server at a time
        const done = await call(transport, "DELETE", serverPath(name))
        if (done?.kind === "ok") list.delete(name)
        else log.warn("opencode: a left MCP server was not removed", name)
      }
      for (const name of sweep.reconnect) {
        // oxlint-disable-next-line no-await-in-loop -- one server at a time
        await call(transport, "POST", `${serverPath(name)}/connect`)
      }
    }
    if (!nothing()) {
      await hand(list, fresh, foreignOf(before))
      readAt = at
    }
    forget(before.gone, deps.records, left)
  }

  // What this session alone needs goes: a server it added is removed, one of the user's it switched off comes back.
  // Nothing another open YellowCode session handed or switched off is touched. A server over one of the user's goes
  // only with a reload of the folder, as removing it would hide theirs until then.
  async function undo(handed: Iterable<string>, off: Iterable<string>, why: string): Promise<void> {
    const transport = deps.transport()
    const now = found()
    const live = now.live
    const rest = others()
    const held = (name: string) =>
      rest.some((one) => one.handed.has(name)) || live.some((entry) => entry.handed.includes(name))
    const kept = (name: string) =>
      rest.some((one) => one.off.has(name)) || live.some((entry) => entry.off.includes(name))
    const drop = [...handed].filter((name) => !held(name))
    const over = drop.filter((name) => folder.own?.has(name) ?? false)
    // What YellowCodes that are gone left over the user's own waits for the same reload.
    const gone = now.gone.flatMap((entry) => entry.replaced).filter((name) => !held(name))
    const restore = [...new Set([...over, ...waiting(), ...gone])]
    if (restore.length > 0) {
      if (await reloaded(transport, why, restore)) {
        forget(now.gone, deps.records)
        return
      }
      for (const name of over) folder.left.add(name)
    }
    for (const name of drop) {
      if (over.includes(name)) continue
      // oxlint-disable-next-line no-await-in-loop -- one server at a time
      await call(transport, "DELETE", serverPath(name))
    }
    for (const name of off) {
      if (kept(name)) continue
      // oxlint-disable-next-line no-await-in-loop -- one server at a time
      await call(transport, "POST", `${serverPath(name)}/connect`)
    }
  }

  const nothing = () => wanted.length === 0 && !leaveOff

  const ready = nothing() && found().gone.length === 0 ? Promise.resolve() : queue(() => start(found()))

  // What this session did is gone when an added server or a switched-off one is not as left. A session that only
  // replaced servers cannot tell, and hands them over again.
  const lost = (list: Map<string, string>, why: "connected" | "changed") => {
    const ours = [...holder.handed.keys()]
    const kept = ours.filter((name) => !(folder.own?.has(name) ?? false))
    if (kept.some((name) => !list.has(name))) return true
    if (why === "changed") return false
    if (kept.length === 0 && holder.off.size === 0) return ours.length > 0
    return [...holder.off].some((name) => list.get(name) !== "disabled")
  }

  return {
    ready: ready.catch((error: unknown) => log.warn("opencode: shared MCP servers not handed", String(error))),
    marks: () => ({ own: folder.own ?? new Set(), handed: new Set(holder.handed.keys()) }),
    set(next, nextOwn) {
      if (closed) return Promise.resolve({ ok: false, problem: "opencode was closed" })
      return queue(async () => {
        const names = new Set(next.map((server) => server.name))
        const gone = [...holder.handed.keys()].filter((name) => !names.has(name))
        const wasOff = new Set(holder.off)
        wanted = [...next]
        if (nextOwn) leaveOff = !nextOwn.on
        for (const name of gone) {
          holder.handed.delete(name)
          holder.leaving.add(name)
        }
        holder.off.clear()
        await hand(await loadedList(deps.transport()))
        await undo(
          gone,
          [...wasOff].filter((name) => !holder.off.has(name)),
          "set",
        )
        holder.leaving.clear()
        save(deps.records)
        return { ok: true as const, note: null }
      })
    },
    toggled(name, on) {
      if (on) holder.off.delete(name)
    },
    check(why, at) {
      if (closed || nothing()) return
      if (why === "reloaded") {
        void queue(async () => {
          if (at === undefined || at >= readAt) await handAll()
        }).catch((error: unknown) => log.warn("opencode: shared MCP servers not handed after a reload", String(error)))
        return
      }
      if (checking) return
      checking = true
      void queue(async () => {
        const list = await listOf(deps.transport())
        if (list && lost(list, why)) await handAll()
      })
        .catch((error: unknown) => log.warn("opencode: shared MCP servers not handed again", String(error)))
        .finally(() => (checking = false))
    },
    async close() {
      if (closed) return
      closed = true
      await queue(async () => {
        try {
          await undo([...holder.handed.keys(), ...holder.leaving], holder.off, "close")
        } finally {
          folder.holders.delete(holder)
          if (folder.holders.size === 0 && folder.left.size === 0) folders.delete(deps.folder)
          save(deps.records)
        }
      }).catch((error: unknown) => log.warn("opencode: shared MCP servers not cleaned up", String(error)))
    },
  }
}
