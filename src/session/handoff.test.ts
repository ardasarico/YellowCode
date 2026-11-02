import { expect, test } from "bun:test"
import { buildHandoff, handoffBudget } from "./handoff.ts"
import type { Item, Session } from "./types.ts"

function conversation(turns: number, size: number): Pick<Session, "items" | "byId" | "rewound"> {
  const list: Item[] = []
  for (let turn = 0; turn < turns; turn++) {
    list.push({
      kind: "user",
      id: `u${turn}`,
      text: `ask ${turn} ${"x".repeat(size)}`,
      images: [],
      to: null,
      queue: null,
    })
    list.push({
      kind: "text",
      id: `a${turn}`,
      markdown: `answer ${turn} ${"y".repeat(size)}`,
      streaming: false,
    })
  }
  return {
    items: list.map((item) => item.id),
    byId: Object.fromEntries(list.map((item) => [item.id, item])),
    rewound: null,
  }
}

test("a conversation that fits moves whole", () => {
  const handoff = buildHandoff(conversation(3, 10), 200_000)
  expect(handoff).toMatchObject({ moved: 6, leftOut: 0 })
  expect(handoff.text).toStartWith("Earlier conversation")
})

test("over the budget it keeps the first user message and the newest, and fits", () => {
  const window = 32_000
  const handoff = buildHandoff(conversation(40, 4_000), window)
  expect(handoff.text.length).toBeLessThanOrEqual(handoffBudget(window))
  expect(handoff.text).toContain("ask 0 ")
  expect(handoff.text).toContain("answer 39 ")
  expect(handoff.moved + handoff.leftOut).toBe(80)
  expect(handoff.leftOut).toBeGreaterThan(0)
  expect(handoff.text).toContain(`[${handoff.leftOut} earlier messages left out]`)
  const kept = handoff.text.match(/^(User|Assistant):$/gm) ?? []
  expect(kept.length).toBe(handoff.moved)
})
