// One answer from Codex for YellowCode's session titles (Codex titles nothing itself): an ephemeral thread that can
// change nothing, on the configured model at its lowest effort, with no reasoning summary.
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
export async function answerOnce(rpc: Rpc, prompt: string, cwd: string): Promise<string | null> {
  const opened = resultOf(
    await rpc.request("thread/start", {
      cwd,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      dynamicTools: [],
      baseInstructions: INSTRUCTIONS,
      config: NO_TOOLS,
    }),
    threadStartResult,
    "thread/start",
  )
  if (opened.kind !== "ok") return null
  const thread = opened.value.thread.id
  const catalog = await readCatalog(rpc).catch(() => [])
  const effort = catalog.find((model) => model.id === opened.value.model)?.supportedReasoningEfforts[0]
  const read = createNotificationReader()
  const answered = (async () => {
    let said: string | null = null
    for await (const message of rpc.incoming) {
      if (message.type === "request") {
        rpc.fail(message.id, UNSUPPORTED, "YellowCode answers nothing here")
        continue
      }
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
