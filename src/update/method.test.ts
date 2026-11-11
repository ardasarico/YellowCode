import { expect, test } from "bun:test"
import { methodOf } from "./method.ts"

test("the install method comes from where the binary lives", () => {
  const cases: [string, string][] = [
    ["/Users/a/.yellowcode/versions/0.3.0/yellowcode", "script"],
    ["/opt/homebrew/Cellar/yellowcode/0.3.0/bin/yellowcode", "brew"],
    ["/home/linuxbrew/.linuxbrew/Cellar/yellowcode/0.3.0/bin/yellowcode", "brew"],
    ["/Users/a/.bun/install/global/node_modules/@yellowcode/darwin-arm64/bin/yellowcode", "bun"],
    [
      "/Users/a/Library/pnpm/store/v11/links/@yellowcode/darwin-arm64/0.3.0/abc/node_modules/@yellowcode/darwin-arm64/bin/yellowcode",
      "pnpm",
    ],
    ["/usr/local/lib/node_modules/yellowcode/node_modules/@yellowcode/darwin-x64/bin/yellowcode", "npm"],
    ["/home/a/.nvm/versions/node/v22.0.0/lib/node_modules/@yellowcode/linux-x64/bin/yellowcode", "npm"],
    ["/Users/a/Downloads/yellowcode", "none"],
  ]
  expect(cases.map(([path]) => [path, methodOf(path)])).toEqual(cases)
  expect(methodOf("/data/yc/versions/0.5.0/yellowcode", "/data/yc")).toBe("script")
})
