import { expect, test } from "bun:test"
import { withoutServerValues } from "./safe-text.ts"

test("a server's values go in every quoted form, and ordinary words and ports stay", () => {
  const secret = 'k3y/"x y'
  const server = { name: "s", command: "npx", args: ["3000"], env: { KEY: secret, WORD: "the " } }
  const text = `the server at port 3000 got ${secret}, ${encodeURIComponent(secret)} and ${JSON.stringify(secret)}`
  expect(withoutServerValues(text, [server])).toBe('the server at port 3000 got …, … and "…"')
})
