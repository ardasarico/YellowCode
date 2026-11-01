// The licences of the packages a release binary carries, gathered from a build's staged node_modules.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { parseJson } from "../src/json.ts"

const Manifest = z.object({ name: z.string(), version: z.string(), license: z.unknown().optional() })
const LICENSE_FILE = /^(?:licen[cs]e|copying|notice|authors|patents)(?:[-_.].*)?$/i

type Found = { name: string; version: string; license: string; texts: string[] }

function packageFolders(nodeModules: string, into: string[] = []): string[] {
  if (!existsSync(nodeModules)) return into
  for (const name of readdirSync(nodeModules)) {
    if (name.startsWith(".")) continue
    const folder = join(nodeModules, name)
    const folders = name.startsWith("@") ? readdirSync(folder).map((inner) => join(folder, inner)) : [folder]
    for (const found of folders) {
      into.push(found)
      packageFolders(join(found, "node_modules"), into)
    }
  }
  return into
}

function read(folder: string): Found | null {
  let text: string
  try {
    text = readFileSync(join(folder, "package.json"), "utf8")
  } catch {
    return null
  }
  const json = parseJson(text)
  const manifest = json.ok ? Manifest.safeParse(json.value).data : undefined
  if (!manifest) return null
  const files = readdirSync(folder)
    .filter((name) => LICENSE_FILE.test(name))
    .toSorted()
  return {
    name: manifest.name,
    version: manifest.version,
    license: typeof manifest.license === "string" ? manifest.license : "see the files below",
    texts: files.map((name) => `--- ${name}\n${readFileSync(join(folder, name), "utf8").trim()}`),
  }
}

const HEADER = `YellowCode binaries include the third-party software listed below, each under its own licence.

The binary is built with Bun (MIT), which carries its own runtime and the libraries it links, among them
JavaScriptCore (LGPL-2). Their licences are listed at https://bun.com/docs/project/licensing.

YellowCode changes dist/layout.js of grok-mermaid 0.2.3 (Apache-2.0). The change is
patches/grok-mermaid@0.2.3.patch in https://github.com/ardasarico/YellowCode.
`

export function thirdPartyLicenses(stage: string): string {
  const seen = new Set<string>()
  const found = packageFolders(join(stage, "node_modules"))
    .map(read)
    .filter((entry): entry is Found => {
      if (!entry || seen.has(`${entry.name}@${entry.version}`)) return false
      seen.add(`${entry.name}@${entry.version}`)
      return true
    })
    .toSorted((a, b) => a.name.localeCompare(b.name))
  const sections = found.map(({ name, version, license, texts }) =>
    [
      `==== ${name} ${version} (${license})`,
      ...(texts.length > 0 ? texts : [`The package has no licence file; see https://www.npmjs.com/package/${name}`]),
    ].join("\n\n"),
  )
  return `${HEADER}\n${sections.join("\n\n")}\n`
}
