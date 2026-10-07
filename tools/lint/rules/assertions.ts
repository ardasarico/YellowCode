import type { ESTree } from "@oxlint/plugins"

export type Assertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion

export function isAssertion(node: ESTree.Node): node is Assertion {
  return node.type === "TSAsExpression" || node.type === "TSTypeAssertion"
}

export function isConstAssertion(node: Assertion): boolean {
  const type = node.typeAnnotation
  return type.type === "TSTypeReference" && type.typeName.type === "Identifier" && type.typeName.name === "const"
}

export function unwrapParentheses(node: ESTree.Expression): ESTree.Expression {
  return node.type === "ParenthesizedExpression" ? unwrapParentheses(node.expression) : node
}
