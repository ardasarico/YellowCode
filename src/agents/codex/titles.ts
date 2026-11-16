// One answer from Codex for YellowCode's session titles (Codex titles nothing itself): an ephemeral thread that can
// change nothing, on the configured model at its lowest effort, with no reasoning summary. A side question asks an
// ephemeral copy of the session the same way.
import type { ModelRef } from "../../agent/ids.ts"
import type { SessionRef } from "../../agent/sessions.ts"
import { readCatalog } from "./models.ts"
import type { Rpc } from "./transport.ts"
import { createNotificationReader } from "./wire/notifications.ts"
import { resultOf, threadStartResult } from "./wire/thread.ts"

const INSTRUCTIONS = "Answer the user's message exactly as it asks, in plain text."

// Codex's own tools, turned off for this thread only.
const NO_TOOLS = {
  "features.shell_tool": false,
  "features.unified_exec": false,
  "features.view_image": false,
  "features.goals": false,
  "features.tool_search": false,
  "features.tool_suggest": false,
  "features.apps": false,
  "features.plugins": false,
  "features.multi_agent": false,
  "features.image_generation": false,
  web_search: "disabled",
}

const UNSUPPORTED = -32601

// The model's last words once the turn completes; null when it did not.
// On `model` it runs at that model's own effort.
export async function answerOnce(
  rpc: Rpc,
  prompt: string,
  cwd: string,
  model: ModelRef | null = null,
  from: SessionRef | null = null,
): Promise<string | null> {
  const fields = {
    cwd,
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
    config: NO_TOOLS,
    ...(model ? { model: model.id } : {}),
    ...(model?.provider ? { modelProvider: model.provider } : {}),
  }
  const opened = resultOf(
    await (from
      ? rpc.request("thread/fork", { threadId: from.id, excludeTurns: true, ...fields })
      : rpc.request("thread/start", { ...fields, dynamicTools: [], baseInstructions: INSTRUCTIONS })),
    threadStartResult,
    from ? "thread/fork" : "thread/start",
  )
  if (opened.kind !== "ok") return null
  const thread = opened.value.thread.id
  const catalog = await readCatalog(rpc).catch(() => [])
  const effort = model ? undefined : catalog.find((row) => row.id === opened.value.model)?.supportedReasoningEfforts[0]
  const read = createNotificationReader()
  const answered = (async () => {
    let said: string | null = null
    for await (const message of rpc.incoming) {
      if (message.type === "request") {
        rpc.fail(message.id, UNSUPPORTED, "YellowCode answers nothing here")
        continue
      }
      if (message.type === "unreadable") continue
      const found = read(message.method, message.params, message.at)
      if (found.kind !== "notification") continue
      const { notification } = found
      if (notification.method === "item/completed" && notification.params.threadId === thread) {
        const { item } = notification.params
        if (item.type === "agentMessage") said = item.text
      }
      if (notification.method === "turn/completed" && notification.params.threadId === thread)
        return notification.params.turn.status === "completed" ? said : null
    }
    return null
  })()
  await rpc.request("turn/start", {
    threadId: thread,
    input: [{ type: "text", text: prompt, text_elements: [] }],
    summary: "none",
    ...(effort ? { effort: effort.reasoningEffort } : {}),
  })
  return answered
}
