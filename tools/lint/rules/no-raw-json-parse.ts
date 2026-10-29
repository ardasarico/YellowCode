import type { Rule } from "@oxlint/plugins"

export const noRawJsonParse: Rule = {
  meta: {
    type: "problem",
    messages: {
      raw: "Use parseJson from src/json.ts and validate the value with a schema.",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (node.computed) return
        if (node.object.type !== "Identifier" || node.object.name !== "JSON") return
        if (node.property.type !== "Identifier" || node.property.name !== "parse") return
        context.report({ node, messageId: "raw" })
      },
    }
  },
}
