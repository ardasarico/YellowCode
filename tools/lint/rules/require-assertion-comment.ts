import type { ESTree, Rule } from "@oxlint/plugins"
import { type Assertion, isConstAssertion } from "./assertions.ts"

const MARKER = "SAFETY:"

function justifies(comment: ESTree.Comment, line: number): boolean {
  const text = comment.value.trim()
  if (!text.startsWith(MARKER) || text.length === MARKER.length) return false
  return comment.loc.start.line === line || comment.loc.end.line === line - 1
}

export const requireAssertionComment: Rule = {
  meta: {
    type: "problem",
    messages: {
      missing: `Explain why this type assertion is safe in a "${MARKER}" comment on the same line or the line above.`,
    },
  },
  create(context) {
    function check(node: Assertion): void {
      if (isConstAssertion(node)) return
      const line = node.loc.start.line
      if (context.sourceCode.getAllComments().some((comment) => justifies(comment, line))) return
      context.report({ node, messageId: "missing" })
    }

    return { TSAsExpression: check, TSTypeAssertion: check }
  },
}
