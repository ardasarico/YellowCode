import { isCoreRuntimeModuleSpecifier, runtimeModuleIdForSpecifier } from "@opentui/core/runtime-plugin"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"
import { plugin } from "bun"
import { realpathSync } from "node:fs"
import { dirname } from "node:path"
import * as solidWeb from "solid-js/web"

// In a standalone binary there is no node_modules to link to. Mods instead get YellowCode's own Solid, OpenTUI and
// yellowcode/mod through OpenTUI's runtime modules. Its stock setup only rewrites a mod's own files: Bun loads a
// dependency named by a bare import without asking the plugins, so the dependency's solid-js import would not resolve.
// Our loader turns those bare imports into paths, which sends every dependency file through the rewrite as well.
const ADDITIONAL = { "solid-js/web": solidWeb, "yellowcode/mod": () => import("./api.ts") }
const SHARED = /^(?:solid-js|@opentui\/solid)(?:\/|$)/

const shared = (specifier: string) =>
  isCoreRuntimeModuleSpecifier(specifier) || specifier in ADDITIONAL || SHARED.test(specifier)
// A package name; not a path, and not a node:, bun: or runtime-module id.
const bare = (specifier: string) => !/^[./]/.test(specifier) && !specifier.includes(":") && specifier !== "bun"
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")

function resolveImport(specifier: string, file: string): string {
  if (shared(specifier)) return runtimeModuleIdForSpecifier(specifier)
  return bare(specifier) ? Bun.resolveSync(specifier, dirname(file)) : specifier
}

// Babel is loaded on the first mod file, not at startup.
const babel = async () => {
  const [{ transformAsync }, ts, moduleResolver, solid] = await Promise.all([
    import("@babel/core"),
    import("@babel/preset-typescript"),
    import("babel-plugin-module-resolver"),
    import("babel-preset-solid"),
  ])
  return { transformAsync, ts: ts.default, moduleResolver: moduleResolver.default, solid: solid.default }
}

async function transform(file: string): Promise<string> {
  const { transformAsync, ts, moduleResolver, solid } = await babel()
  const code = await Bun.file(file).text()
  const presets: unknown[] = []
  if (/\.[cm]?[jt]sx$/.test(file)) {
    presets.push([solid, { moduleName: runtimeModuleIdForSpecifier("@opentui/solid"), generate: "universal" }])
  }
  if (/\.[cm]?tsx?$/.test(file)) presets.push([ts])
  const result = await transformAsync(code, {
    filename: file,
    configFile: false,
    babelrc: false,
    plugins: [[moduleResolver, { resolvePath: resolveImport }]],
    presets,
  })
  return result?.code ?? code
}

let installed = false

export function installModLoader(modsFolder: string): void {
  if (installed) return
  installed = true
  const folders = [...new Set([modsFolder, realpathSync(modsFolder)])].map(escape).join("|")
  plugin({
    name: "yellowcode-mods",
    setup(build) {
      const filter = new RegExp(`^(?:${folders})/(?!.*/node_modules/).*\\.[cm]?[jt]sx?(?:\\?.*)?$`)
      build.onLoad({ filter }, async (args) => ({
        contents: await transform(args.path.replace(/\?.*$/, "")),
        loader: "js",
      }))
    },
  })
  ensureRuntimePluginSupport({ additional: ADDITIONAL })
}
