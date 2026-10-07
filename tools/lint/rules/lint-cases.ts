import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const pluginPath = join(import.meta.dir, "..", "plugin.ts")
const oxlintPath = join(import.meta.dir, "..", "..", "..", "node_modules", ".bin", "oxlint")

type Diagnostic = { filename: string }

function isDiagnostic(value: unknown): value is Diagnostic {
  return typeof value === "object" && value !== null && "filename" in value && typeof value.filename === "string"
}

function parseDiagnostics(output: string): Diagnostic[] {
  const parsed: unknown = JSON.parse(output)
  if (typeof parsed !== "object" || parsed === null || !("diagnostics" in parsed)) {
    throw new Error(`Unexpected oxlint output: ${output}`)
  }
  const { diagnostics } = parsed
  if (!Array.isArray(diagnostics) || !diagnostics.every(isDiagnostic)) {
    throw new Error(`Unexpected oxlint diagnostics: ${output}`)
  }
  return diagnostics
}

export async function countReports(rule: string, samples: string[]): Promise<number[]> {
  const dir = await mkdtemp(join(tmpdir(), "yellowcode-lint-"))

  try {
    const files = samples.map((_, index) => join(dir, `sample-${index}.ts`))
    await Promise.all(samples.map((code, index) => writeFile(files[index] ?? "", code)))

    const config = {
      plugins: [],
      categories: { correctness: "off" },
      jsPlugins: [{ name: "yellowcode", specifier: pluginPath }],
      rules: { [`yellowcode/${rule}`]: "error" },
    }
    const configPath = join(dir, "oxlintrc.json")
    await writeFile(configPath, JSON.stringify(config))

    const result = Bun.spawnSync([oxlintPath, "-c", configPath, "--format", "json", ...files])
    const diagnostics = parseDiagnostics(result.stdout.toString())
    return files.map((file) => diagnostics.filter((diagnostic) => diagnostic.filename === file).length)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
