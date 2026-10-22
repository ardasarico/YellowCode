import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js"
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

// The prompts newest first; under them, one line on what rewinding to the selected one undoes, notes on what it
// cannot undo or will stop, and one for files changed after Claude. Enter rewinds the code and the conversation,
// `c` only the conversation.
export function RewindDialog(
  props: RewindLook & {
    // What the snapshots know, when it came too late for the dialog to open with it.
    late?: Promise<RewindLook | null>
    // Resolves once the rewind is done, or with what changed since the dialog showed its ⚠; then it stays open.
    onRewind: (rewound: Rewound, seen: string[]) => Promise<RewindRecheck | null>
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
  const runDry = async (at: number) => {
    const found = dryRun ? await dryRun(at).catch(() => null) : null
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
    if (later.some((point) => point.untracked)) note("untracked", "Files not tracked here")
    if (later.some((point) => point.imported)) note("imported", "Only Claude's edits here")
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
          ? `⚠ ${only.path} changed after Claude`
          : `⚠ ${conflicts.length} files changed after Claude: ${conflicts.map((file) => file.path).join(", ")}`
      lines.push({ id: "conflicts", spans: [{ text: cut(text, inner()), fg: theme.warning }] })
    }
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
      await late
      if (dryRun && !untrack(done).has(at)) await runDry(at)
      if (work.closed || index() !== at) return
      const shownNow = conflictFiles().map((file) => file.path)
      if (shownNow.some((path) => !seen.has(path))) return
      const asked = rewound(false)
      if (!asked) return
      const answer = await props.onRewind(asked, shownNow)
      if (work.closed) return
      if (!answer) return props.onClose()
      setRestores((previous) => new Map(previous).set(at, answer.paths))
      setAtEnter((previous) => new Set([...previous, ...answer.conflicts]))
    } finally {
      entering = false
    }
  }

  const keep = () => {
    const asked = rewound(true)
    if (!asked) return
    void props.onRewind(asked, [])
    props.onClose()
  }

  const sections = () => [
    {
      title: "",
      rows: shown
        .toReversed()
        .map((point) => ({ id: point.userId, label: cut(flat(point.text) || "(image)", inner() - 2) })),
    },
  ]

  return (
    <Dialog
      title="Rewind"
      width={WIDTH}
      sections={sections()}
      pinned={summary()}
      footer={[
        { action: "rewind", key: "enter", needsRow: true },
        { action: "keep files", key: "c", needsRow: true },
        { action: "close", key: "esc" },
      ]}
      footerStyle="keys"
      view="rewind"
      initialSelected={selected()}
      search={false}
      onSelect={(row) => setSelected(row.id)}
      onEnter={() => void enter()}
      onKey={(key) => {
        if (key.name !== "c" || key.ctrl || key.meta) return false
        if (!entering) keep()
        return true
      }}
      onEscape={props.onClose}
      empty={() => "Nothing to rewind yet."}
    />
  )
}
