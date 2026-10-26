import type { KeyEvent } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createComponent, createSignal, ErrorBoundary, Match, Switch, untrack } from "solid-js"
import type { ModChooseOptions, ModConfirmOptions, ModDialogOptions, ModInputOptions } from "../mods/api.ts"
import { guarded, type ModDialogRequest, reportModError } from "../mods/registry.ts"
import { Dialog } from "./dialog/dialog.tsx"
import { printable, SearchRow } from "./dialog/list-view.tsx"
import { CHROME_ROWS, ConfirmPanel, Panel, WIDTH } from "./dialog/panel.tsx"

const WIDE_MARGIN = 6
// More items than this get a search row.
const SEARCH_FROM = 8
const NORMAL_HEIGHT = 24

type Close = (answer: unknown) => void

function Choose(props: { options: ModChooseOptions; mod: string; close: Close }) {
  return (
    <Dialog
      title={props.options.title}
      sections={[{ title: "", rows: props.options.items.map((item) => ({ ...item })) }]}
      footer={[
        { action: "Choose", key: "enter", needsRow: true },
        { action: "Cancel", key: "esc" },
      ]}
      search={props.options.search ?? props.options.items.length > SEARCH_FROM}
      view={`mod-${props.mod}`}
      onEnter={(row) => props.close(row.id)}
      onKey={() => false}
      onEscape={() => props.close(null)}
    />
  )
}

function Confirm(props: { options: ModConfirmOptions; close: Close }) {
  useKeyboard((key) => {
    key.stopPropagation()
    key.preventDefault()
    if (key.name === "return") props.close(true)
    else if (key.name === "escape") props.close(null)
  })
  return <ConfirmPanel {...props.options} />
}

function Input(props: { options: ModInputOptions; close: Close }) {
  const [text, setText] = createSignal(untrack(() => props.options.initial ?? ""))
  useKeyboard((key) => {
    key.stopPropagation()
    key.preventDefault()
    if (key.name === "return") props.close(text())
    else if (key.name === "escape") props.close(null)
    else if (key.name === "backspace") setText((value) => Array.from(value).slice(0, -1).join(""))
    else if (printable(key)) setText((value) => value + key.sequence)
  })
  return (
    <Panel
      width={WIDTH}
      height={CHROME_ROWS + 1}
      title={props.options.title}
      footer={[
        { action: "Save", key: "enter" },
        { action: "Cancel", key: "esc" },
      ]}
    >
      {() => <SearchRow query={text()} placeholder={props.options.placeholder ?? ""} pad={0} />}
    </Panel>
  )
}

function Custom(props: { options: ModDialogOptions; mod: string; close: Close }) {
  const dimensions = useTerminalDimensions()
  const mod = untrack(() => props.mod)
  let handler: ((key: KeyEvent) => void) | null = null
  useKeyboard((key) => {
    key.stopPropagation()
    key.preventDefault()
    if (key.name === "escape") props.close(null)
    else if (handler) {
      const run = handler
      guarded(mod, () => run(key))
    }
  })
  const wide = () => props.options.wide === true
  return (
    <Panel
      width={wide() ? dimensions().width - WIDE_MARGIN : WIDTH}
      height={wide() ? dimensions().height - 2 : NORMAL_HEIGHT}
      title={props.options.title}
      footer={[...(props.options.hints ?? []), { action: "Close", key: "esc" }]}
    >
      {(inner, rows) => (
        <ErrorBoundary
          fallback={(error: unknown) => {
            queueMicrotask(() => reportModError(mod, error))
            return null
          }}
        >
          {createComponent(props.options.view, {
            get width() {
              return inner()
            },
            get height() {
              return rows()
            },
            onKey: (next) => {
              handler = next
              return () => {
                if (handler === next) handler = null
              }
            },
            close: () => props.close(null),
          })}
        </ErrorBoundary>
      )}
    </Panel>
  )
}

// The dialog a mod opened, drawn with the parts of the built-in ones.
export function ModDialogView(props: { request: ModDialogRequest }) {
  const close: Close = (answer) => props.request.close(answer)
  return (
    <Switch>
      <Match when={props.request.kind === "choose" && props.request}>
        {(request) => <Choose options={request().options} mod={request().mod} close={close} />}
      </Match>
      <Match when={props.request.kind === "confirm" && props.request}>
        {(request) => <Confirm options={request().options} close={close} />}
      </Match>
      <Match when={props.request.kind === "input" && props.request}>
        {(request) => <Input options={request().options} close={close} />}
      </Match>
      <Match when={props.request.kind === "open" && props.request}>
        {(request) => <Custom options={request().options} mod={request().mod} close={close} />}
      </Match>
    </Switch>
  )
}
