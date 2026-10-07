import type { Plugin } from "@oxlint/plugins"
import { noChainedTypeAssertions } from "./rules/no-chained-type-assertions.ts"
import { requireAssertionComment } from "./rules/require-assertion-comment.ts"

const plugin: Plugin = {
  meta: { name: "yellowcode" },
  rules: {
    "no-chained-type-assertions": noChainedTypeAssertions,
    "require-assertion-comment": requireAssertionComment,
  },
}

export default plugin
