import type { Plugin } from "@oxlint/plugins"
import { agentBoundary } from "./rules/agent-boundary.ts"
import { noChainedTypeAssertions } from "./rules/no-chained-type-assertions.ts"
import { noRawJsonParse } from "./rules/no-raw-json-parse.ts"
import { requireAssertionComment } from "./rules/require-assertion-comment.ts"

const plugin: Plugin = {
  meta: { name: "yellowcode" },
  rules: {
    "agent-boundary": agentBoundary,
    "no-chained-type-assertions": noChainedTypeAssertions,
    "no-raw-json-parse": noRawJsonParse,
    "require-assertion-comment": requireAssertionComment,
  },
}

export default plugin
