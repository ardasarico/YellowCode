/* oxlint-disable no-await-in-loop */
import { test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { startTheme } from "../../theme/theme.ts"
import { Markdown } from "./markdown.tsx"

async function stream(deltas: string[]) {
  const chat = { itemId: "i1", selection: null, expanded: {}, onOpenImage() {}, onOpenRef() {}, onToggle() {} }
  const [markdown, setMarkdown] = createSignal("")
  const setup = await testRender(() => <Markdown chat={chat} markdown={markdown()} streaming={true} width={80} />, {
    width: 80,
    height: 20,
  })
  startTheme(setup.renderer.nativeScene, "terminal")
  let text = ""
  for (const delta of deltas) {
    text += delta
    setMarkdown(text)
    await setup.renderOnce()
  }
  setup.renderer.destroy()
}

test("a block that changes kind while streaming does not throw", async () => {
  await stream(["a\n\nb", "\n\nc", " d\n\n``", "`ts\nx\n```"])
  await stream(["s", "ee pa", "ckage.json\n---\n"])
})
