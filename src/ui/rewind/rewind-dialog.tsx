import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js"
import { log } from "../../log/log.ts"
import { type RewindPoint, type RewindRecheck, type Rewound, undone } from "../../session/rewind.ts"
import { theme } from "../../theme/theme.ts"
import { Dialog } from "../dialog/dialog.tsx"
import { PAD_X } from "../dialog/list-view.tsx"
import type { DialogText } from "../dialog/list.ts"
import { cut, printable } from "../format.ts"

const WIDTH = 72

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`
const flat = (text: string) => printable(text).replace(/\s+/g, " ").trim()

export type RewindLook = {
  points: RewindPoint[]
  // Works out what a rewind to another prompt would restore; the dialog asks for every shown prompt in turn.
  dryRun?: (prompt: number) => Promise<string[] | null>
}

const restoresOf = (points: RewindPoint[]) =>
  new Map(points.flatMap((point, at) => (point.restores ? [[at, point.restores] as const] : [])))

// The timeline: the prompts newest first, and the chat follows the selected one. Under them, one line on what rewinding
// to it undoes, notes on what it cannot undo or will stop, and one for files changed after the agent. Enter opens what
// can be done with the prompt; `r` rewinds the code and the conversation at once, `c` only the conversation.
export function RewindDialog(
  props: RewindLook & {
    // What the chat calls the agent in short texts.
    agent: string
    // What the snapshots know, when it came too late for the dialog to open with it.
    late?: Promise<RewindLook | null>
    // Resolves once the rewind is done, or with what changed since the dialog showed its ⚠; then it stays open.
    onRewind: (rewound: Rewound, seen: string[]) => Promise<RewindRecheck | null>
    // The chat shows the selected prompt; Go here leaves it there.
    onFocus: (userId: string) => void
    onGo: () => void
    onCopy: (text: string) => void
    onClose: () => void
  },
) {
  const dimensions = useTerminalDimensions()
  // The dialog's inner width, as the shared frame sizes it.
  const inner = () => (dimensions().width < WIDTH + 6 ? dimensions().width : WIDTH) - PAD_X * 2
  // The points change only once, when a late preview lands; the prompts stay the same.
  const [points, setPoints] = createSignal(untrack(() => props.points))
  const shown = untrack(points).filter((point) => !point.hidden)
  const [selected, setSelected] = createSignal(shown.at(-1)?.userId)
  const index = () => points().findIndex((point) => point.userId === selected())
  // Dry run results by prompt index; until a prompt's lands, its summary counts the chat's files.
  const [restores, setRestores] = createSignal(restoresOf(untrack(points)))
  // Prompts whose dry run has run; until then a live dialog shows no ⚠ for the prompt.
  const [done, setDone] = createSignal(new Set(untrack(restores).keys()))
  let dryRun = untrack(() => props.dryRun)
  // ⚠ paths Enter found that the dry runs had not.
  const [atEnter, setAtEnter] = createSignal(new Set<string>())
  const files = createMemo(() => (index() < 0 ? [] : undone(points(), index(), restores().get(index()) ?? null)))

  const work = { closed: false }
  onCleanup(() => {
    work.closed = true
  })
  // Prompts whose last dry run failed; Enter still checks the files itself.
  const [unchecked, setUnchecked] = createSignal(new Set<number>())
  // Enter waits for a late preview or a dry run.
  const [waiting, setWaiting] = createSignal(false)
  const runDry = async (at: number) => {
    let failed = false
    const found = dryRun
      ? await dryRun(at).catch((error: unknown) => {
          log.warn("rewind dry run failed", { prompt: at, error: String(error) })
          failed = true
          return null
        })
      : null
    setUnchecked((previous) => {
      const next = new Set(previous)
      if (failed) next.add(at)
      else next.delete(at)
      return next
    })
    setDone((previous) => new Set(previous).add(at))
    if (found) setRestores((previous) => new Map(previous).set(at, found))
  }
  // The selected prompt first, then the others nearest to it, one at a time.
  const runAll = () => {
    if (!dryRun) return
    const ready = untrack(done)
    const all = untrack(points)
    const left = new Set(
      shown.map((point) => all.findIndex((found) => found.userId === point.userId)).filter((at) => !ready.has(at)),
    )
    const next = () => {
      const at = untrack(index)
      if (left.has(at)) return at
      return [...left].toSorted((a, b) => Math.abs(a - at) - Math.abs(b - at))[0]
    }
    void (async () => {
      for (let at = next(); at !== undefined && !work.closed; at = next()) {
        left.delete(at)
        // oxlint-disable-next-line no-await-in-loop -- one at a time, so a new selection goes next
        await runDry(at)
      }
    })()
  }
  onMount(runAll)
  const late = untrack(() => props.late)?.then((look) => {
    if (!look || work.closed) return
    setPoints(look.points)
    setRestores(restoresOf(look.points))
    setDone(new Set(restoresOf(look.points).keys()))
    dryRun = look.dryRun
    runAll()
  })

  // Only paths the restore would change; without a dry run's result yet, none.
  const conflictFiles = () => {
    const at = index()
    if (at < 0 || (dryRun && !done().has(at))) return []
    return files().filter((file) => file.conflict || atEnter().has(file.path))
  }

  const summary = (): DialogText[] => {
    const at = index()
    if (at < 0) return []
    const prompts = plural(points().length - at, "prompt")
    const changed = files().length > 0 ? plural(files().length, "file") : "no file changes"
    const lines: DialogText[] = [
      { id: "gap", spans: [] },
      {
        id: "summary",
        spans: [{ text: `Goes back to before this prompt · ${prompts}, ${changed}`, fg: theme.panelMuted }],
      },
    ]
    const later = points().slice(at)
    const note = (id: string, text: string) =>
      lines.push({ id, spans: [{ text: cut(text, inner()), fg: theme.panelMuted }] })
    if (later.some((point) => point.untracked)) {
      const why = later.find((point) => point.untrackedWhy)?.untrackedWhy
      note("untracked", why ? `Files not tracked: ${why}` : "Files not tracked here")
    }
    if (later.some((point) => point.imported)) note("imported", `Only ${props.agent}'s edits here`)
    const tasks = later.flatMap((point) => point.tasks)
    if (tasks.length > 0) note("tasks", `Stops ${plural(tasks.length, "background task")}: ${tasks.join(", ")}`)
    const shells = later.flatMap((point) => point.shells)
    if (shells.length > 0)
      note("shells", `Keeps later changes from ${plural(shells.length, "background shell")}: ${shells.join(", ")}`)
    const outside = [...new Set(later.flatMap((point) => point.outside))]
    if (outside.length > 0)
      note("outside", `Keeps ${plural(outside.length, "file")} outside the project: ${outside.join(", ")}`)
    const conflicts = conflictFiles()
    const [only] = conflicts
    if (conflicts.length > 0) {
      const text =
        conflicts.length === 1 && only
          ? `⚠ ${only.path} changed after ${props.agent}`
          : `⚠ ${conflicts.length} files changed after ${props.agent}: ${conflicts.map((file) => file.path).join(", ")}`
      lines.push({ id: "conflicts", spans: [{ text: cut(text, inner()), fg: theme.warning }] })
    }
    if (unchecked().has(at)) {
      const text = "Could not check the files · Enter checks them again"
      lines.push({ id: "unchecked", spans: [{ text: cut(text, inner()), fg: theme.warning }] })
    }
    if (waiting()) note("waiting", "Checking files…")
    return lines
  }

  const rewound = (keptFiles: boolean): Rewound | null => {
    const at = index()
    const point = points()[at]
    if (!point) return null
    return { userId: point.userId, prompts: points().length - at, files: files(), keptFiles }
  }

  // Enter waits for what the dialog does not know yet: a late preview, the selected prompt's dry run, and the files as
  // they are at Enter. A ⚠ that shows up meanwhile needs a second Enter.
  let entering = false
  const enter = async () => {
    if (entering) return
    entering = true
    const at = index()
    try {
      const seen = new Set(conflictFiles().map((file) => file.path))
      setWaiting(true)
      await late
      if (dryRun && !untrack(done).has(at)) await runDry(at)
      setWaiting(false)
      if (work.closed || index() !== at) return
      const shownNow = conflictFiles().map((file) => file.path)
      if (shownNow.some((path) => !seen.has(path))) return
      const asked = rewound(false)
      if (!asked) return
      const answer = await props.onRewind(asked, shownNow)
      if (work.closed) return
      if (!answer) return props.onClose()
      // Enter checked the files itself.
      setUnchecked((previous) => new Set([...previous].filter((prompt) => prompt !== at)))
      setRestores((previous) => new Map(previous).set(at, answer.paths))
      setAtEnter((previous) => new Set([...previous, ...answer.conflicts]))
    } finally {
      setWaiting(false)
      entering = false
    }
  }

  const keep = () => {
    const asked = rewound(true)
    if (!asked) return
    props.onRewind(asked, []).catch((error: unknown) => log.warn("rewind failed", String(error)))
    props.onClose()
  }

  // The actions view is open for the selected prompt.
  const [acting, setActing] = createSignal(false)
  const promptText = () => flat(points()[index()]?.text ?? "") || "(image)"
  const fileCount = () => (files().length > 0 ? plural(files().length, "file") : "no files")
  const sections = () =>
    acting()
      ? [
          {
            title: "",
            rows: [
              { id: "rewind", label: "Rewind", value: `conversation and ${fileCount()}` },
              { id: "keep", label: "Rewind, keep files", value: "conversation only" },
              { id: "go", label: "Go here", value: "scroll the chat to it" },
              { id: "copy", label: "Copy", value: "prompt text" },
            ],
          },
        ]
      : [
          {
            title: "",
            rows: shown
              .toReversed()
              .map((point) => ({ id: point.userId, label: cut(flat(point.text) || "(image)", inner() - 2) })),
          },
        ]

  const act = (id: string) => {
    const userId = selected()
    if (id === "rewind") void enter()
    else if (id === "keep") {
      if (!entering) keep()
    } else if (id === "go" && userId) props.onGo()
    else if (id === "copy") props.onCopy(points()[index()]?.text ?? "")
  }

  return (
    <Dialog
      title={acting() ? cut(`Timeline › ${promptText()}`, inner()) : "Timeline"}
      width={WIDTH}
      sections={sections()}
      pinned={summary()}
      footer={
        acting()
          ? [
              { action: "select", key: "↑↓" },
              { action: "run", key: "enter", needsRow: true },
              { action: "back", key: "esc" },
            ]
          : [
              { action: "actions", key: "enter", needsRow: true },
              { action: "rewind", key: "r", needsRow: true },
              { action: "keep files", key: "c", needsRow: true },
              { action: "close", key: "esc" },
            ]
      }
      footerStyle="keys"
      view={acting() ? "actions" : "list"}
      initialSelected={acting() ? "rewind" : selected()}
      search={false}
      onSelect={(row) => {
        if (acting()) return
        setSelected(row.id)
        props.onFocus(row.id)
      }}
      onEnter={(row) => (acting() ? act(row.id) : setActing(true))}
      onKey={(key) => {
        if (acting() || key.ctrl || key.meta) return false
        if (key.name === "r") void enter()
        else if (key.name === "c") {
          if (!entering) keep()
        } else return false
        return true
      }}
      onEscape={() => (acting() ? setActing(false) : props.onClose())}
      empty={() => "No prompts yet."}
    />
  )
}
