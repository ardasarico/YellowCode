import type { ESTree, Rule } from "@oxlint/plugins"
import { type Assertion, isAssertion, isConstAssertion, unwrapParentheses } from "./assertions.ts"

function innerAssertion(node: Assertion): Assertion | undefined {
  const inner = unwrapParentheses(node.expression)
  return isAssertion(inner) ? inner : undefined
}

function isInsideAssertion(node: ESTree.Node): boolean {
  let parent = node.parent
  while (parent?.type === "ParenthesizedExpression") parent = parent.parent
  return parent !== null && isAssertion(parent)
}

export const noChainedTypeAssertions: Rule = {
  meta: {
    type: "problem",
    messages: {
      chained: "Do not chain type assertions. Validate the value or fix its type instead.",
    },
  },
  create(context) {
    function check(node: Assertion): void {
      const inner = innerAssertion(node)
      if (inner === undefined || isInsideAssertion(node)) return
      if (isConstAssertion(node) && isConstAssertion(inner)) return
      context.report({ node, messageId: "chained" })
    }

    return { TSAsExpression: check, TSTypeAssertion: check }
  },
}
