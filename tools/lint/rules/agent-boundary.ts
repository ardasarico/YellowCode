import type { ESTree, Rule } from "@oxlint/plugins"
import { dirname, relative, resolve, sep } from "node:path"

// Code only an agent's adapter may use: Claude's wire and connection.
const ADAPTER_ONLY = ["src/agents/", "src/protocol/", "src/source/"]

function allowedFiles(options: readonly unknown[]): string[] {
  const first: unknown = options[0]
  if (typeof first !== "object" || first === null || !("allow" in first) || !Array.isArray(first.allow)) return []
  return first.allow.filter((file): file is string => typeof file === "string")
}

export const agentBoundary: Rule = {
  meta: {
    type: "problem",
    messages: {
      adapter: "{{module}} belongs to an agent's adapter; reach the agent through src/agent/ instead.",
    },
    schema: [
      {
        type: "object",
        properties: { allow: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const allow = allowedFiles(context.options)
    function check(source: ESTree.StringLiteral): void {
      if (!source.value.startsWith(".")) return
      const module = relative(context.cwd, resolve(dirname(context.filename), source.value))
        .split(sep)
        .join("/")
      if (allow.includes(module)) return
      if (ADAPTER_ONLY.some((path) => (path.endsWith("/") ? module.startsWith(path) : module === path)))
        context.report({ node: source, messageId: "adapter", data: { module } })
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => {
        if (node.source) check(node.source)
      },
      ImportExpression: (node) => {
        if (node.source.type === "Literal" && typeof node.source.value === "string") check(node.source)
      },
      TSImportType: (node) => check(node.source),
    }
  },
}
