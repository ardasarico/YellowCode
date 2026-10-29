import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { testRender } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import { replayAgent } from "../../tools/opencode/agent-driver.ts"
import { savedRule } from "../../tools/opencode/scenarios/settings.ts"
import { readFixture } from "../agents/opencode/fixture.ts"
import { createSession } from "../session/session.ts"
import { startTheme } from "../theme/theme.ts"
import { PermissionsDialog } from "./permissions-dialog.tsx"

const fixture = readFixture(
  readFileSync(join(import.meta.dir, "..", "..", "fixtures", "opencode", "rules.jsonl"), "utf8"),
)
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

test("/permissions lists the rule an always saved, and Delete removes it from opencode; a config rule stays", async () => {
  const store = createSession({ starting: true })
  const frames: string[] = []
  const run = await replayAgent(
    async (a) => {
      await savedRule(a)
      const [themed, setThemed] = createSignal(false)
      const setup = await testRender(
        () => (
          <Show when={themed()}>
            <PermissionsDialog
              agent="opencode"
              rules={store.lists().rules ?? null}
              onRemove={(id) => a.removeRule(id)}
              onClose={() => {}}
            />
          </Show>
        ),
        { width: 80, height: 16 },
      )
      startTheme(setup.renderer.nativeScene, "terminal")
      setThemed(true)
      const frame = async () => {
        await settle()
        await setup.renderOnce()
        frames.push(setup.captureCharFrame())
      }
      await frame()
      setup.mockInput.pressKey("DELETE")
      await a.until("lists", (event) => event.lists.rules?.every((rule) => !rule.removable) === true)
      await frame()
      setup.renderer.destroy()
    },
    fixture,
    { store },
  )
  expect(run.transport.unused()).toEqual([])
  expect(frames[0]).toContain("shell git status *")
  expect(frames[0]).toContain("this project")
  expect(frames[0]).toContain("Delete del")
  // The config file's rule stays, and has no Delete.
  expect(frames[1]).not.toContain("git status")
  expect(frames[1]).toContain("shell *")
  expect(frames[1]).toContain("everywhere")
  expect(frames[1]).not.toContain("Delete del")
})
