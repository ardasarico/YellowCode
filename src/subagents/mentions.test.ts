import { expect, test } from "bun:test"
import { mentionNames } from "../input/token.ts"
import type { ModelChoice } from "./asks.ts"
import { mentionName, resolveName } from "./mentions.ts"

const choice = (provider: string, inner: string | null, id: string): ModelChoice => ({
  provider: { id: provider, name: provider },
  row: {
    ref: { provider: inner, id },
    label: id,
    note: "",
    resolves: null,
    efforts: [],
    images: false,
    window: null,
  },
})

const flash = choice("opencode", "openrouter", "deepseek-v4-flash")
const piFlash = choice("pi", "openrouter", "deepseek-v4-flash")
const opus = choice("claude", null, "claude-opus-5-5")

test("a name on one row is its id, on several the provider and model in full", () => {
  expect(mentionName(opus, [flash, opus])).toBe("claude-opus-5-5")
  expect(mentionName(flash, [flash, opus])).toBe("deepseek-v4-flash")
  expect(mentionName(flash, [flash, piFlash])).toBe("opencode/openrouter/deepseek-v4-flash")
  expect(mentionName(piFlash, [flash, piFlash])).toBe("pi/openrouter/deepseek-v4-flash")
})

test("a full name resolves to its one row, a short one to every row it fits", () => {
  expect(resolveName("pi/openrouter/deepseek-v4-flash", [flash, piFlash])).toEqual([piFlash])
  expect(resolveName("deepseek-v4-flash", [flash, piFlash])).toEqual([flash, piFlash])
  expect(resolveName("openrouter/deepseek-v4-flash", [flash, opus])).toEqual([flash])
})

test("mention names come without the @ and quotes", () => {
  expect(mentionNames('@deepseek-v4-flash write @"my file.ts" and mail a@b')).toEqual([
    "deepseek-v4-flash",
    "my file.ts",
  ])
})
