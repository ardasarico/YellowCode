import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { AgentScenario } from "../scenario.ts"
import { ECHO, node } from "./tools.ts"
import { turn } from "./turns.ts"

const PROJECT_CONFIG = 'model_verbosity = "low"\n'

// Planted where the allowlist must drop them: a provider's headers and key name, an MCP server's environment and
// otel's headers. None may reach the fixture or the rows.
const PLANTED = [
  "[model_providers.other]",
  'name = "Other"',
  'base_url = "http://127.0.0.1:9/v1"',
  'env_key = "PLANTED_PROVIDER_KEY"',
  'http_headers = { "X-Planted" = "planted-provider-header" }',
  "",
  "[mcp_servers.quiet]",
  'command = "true"',
  'env = { PLANTED_MCP_KEY = "planted-mcp-env" }',
  "",
  "[otel]",
  'exporter = { otlp-http = { endpoint = "http://127.0.0.1:9/v1", protocol = "binary", headers = { "x-planted" = "planted-otel-header" } } }',
  "",
].join("\n")

const ok = (outcome: { ok: boolean; problem?: string }, what: string) => {
  if (!outcome.ok) throw new Error(`${what}: ${outcome.problem}`)
}

// The rows read, four writes (the project's file wins over one; another client's write in between makes the last one
// read config.toml again), a value the row does not take, and the rows read again.
export const settings: AgentScenario = {
  name: "settings",
  top: 'web_search = "live"\nmodel_auto_compact_token_limit = 50000',
  files: { ".codex/config.toml": PROJECT_CONFIG },
  config: PLANTED,
  script: { threads: [] },
  async run(a) {
    await a.start()
    await a.settings()
    ok(await a.writeSetting("web-search", "disabled"), "web search")
    ok(await a.writeSetting("verbosity", "high"), "verbosity")
    ok(await a.writeSetting("compaction.threshold", 60000), "threshold")
    await a.raw("config/value/write", { keyPath: "tool_output_token_limit", value: 2000, mergeStrategy: "replace" })
    ok(await a.writeSetting("login-shell", "false"), "login shell")
    if ((await a.writeSetting("web-search", "bogus")).ok) throw new Error("a value the row does not take was written")
    await a.settings()
    await a.close()
  },
  async verify(root) {
    const user = await readFile(join(root.codex, "config.toml"), "utf8")
    for (const line of [
      'web_search = "disabled"',
      'model_verbosity = "high"',
      "model_auto_compact_token_limit = 60000",
      "allow_login_shell = false",
      "tool_output_token_limit = 2000",
    ])
      if (!user.includes(line)) throw new Error(`config.toml has no ${line}`)
    if ((await readFile(join(root.project, ".codex", "config.toml"), "utf8")) !== PROJECT_CONFIG)
      throw new Error("the project's config.toml changed")
  },
}

const SKILL = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`

// Skills of the project, the user and Codex itself, an MCP server that runs and one that cannot, a hook and no
// plugins: each list read, a skill turned off and on, the skills read from disk again, a reload of the servers, a
// login that cannot start, file matches, and a skill run as a command.
export const lists: AgentScenario = {
  name: "lists",
  files: {
    ".agents/skills/greet/SKILL.md": SKILL("greet", "Say hello", "Answer with GREETED and nothing else."),
    ".mcp/echo.ts": ECHO,
  },
  home: { "skills/tidy/SKILL.md": SKILL("tidy", "Tidy up", "Tidy.") },
  config: (root) =>
    [
      "[mcp_servers.echo]",
      `command = "${node()}"`,
      `args = ["${join(root.project, ".mcp", "echo.ts")}"]`,
      "",
      "[mcp_servers.remote]",
      'url = "http://127.0.0.1:9/mcp"',
      "",
      "[[hooks.PreToolUse]]",
      'matcher = "Bash"',
      'hooks = [{ type = "command", command = "true" }]',
      "",
    ].join("\n"),
  script: { threads: [{ match: "say hi", steps: [[{ type: "text", text: "GREETED" }]] }] },
  async run(a) {
    await a.start()
    const greet = join(a.directory, ".agents", "skills", "greet", "SKILL.md")
    a.refresh("commands")
    await a.until("lists", (event) => event.lists.commands !== undefined)
    a.refresh("mcp")
    await a.until("lists", (event) => event.lists.mcp !== undefined)
    ok(await a.toggleSkill(greet, false), "skill off")
    ok(await a.toggleSkill(greet, true), "skill on")
    ok(await a.reloadSkills(), "skills reload")
    ok(await a.reconnectMcp("echo"), "MCP reload")
    if ((await a.loginMcp("remote")).ok) throw new Error("a login with no page opened")
    await a.files("a")
    await a.files("src")
    await turn(a, "/greet say hi")
    await a.close()
  },
  async verify(root) {
    const bodies = await readFile(join(root.root, "bodies.jsonl"), "utf8")
    if (!bodies.includes("Answer with GREETED and nothing else.")) throw new Error("the skill did not reach the model")
  },
}
