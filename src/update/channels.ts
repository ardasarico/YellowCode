import { z } from "zod"
import { parseJson } from "../json.ts"

export const CHANNELS = ["stable", "beta"] as const
export type Channel = (typeof CHANNELS)[number]

const SEMVER = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/

const asset = (protocol: RegExp) =>
  z.object({
    url: z.url({ protocol }),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be 64 hex characters"),
  })

const release = (Asset: ReturnType<typeof asset>) =>
  z.object({
    version: z.string().regex(SEMVER, "must be like 1.2.3 or 1.2.3-beta.4"),
    commit: z.string().regex(/^[0-9a-f]{40}$/, "must be a full 40-character commit SHA"),
    // The bundle hash of the commit (tools/build.ts), so a stable rebuild can prove it holds the beta's code.
    bundle: z.string().regex(/^[0-9a-f]{64}$/, "must be 64 hex characters"),
    assets: z.object({ "darwin-arm64": Asset, "darwin-x64": Asset, "linux-x64": Asset, "linux-arm64": Asset }),
  })

const schema = (protocol: RegExp) => {
  const Release = release(asset(protocol))
  return z.object({ stable: Release.nullable(), beta: Release.nullable() })
}
const Channels = schema(/^https$/)
// A channel file read from disk for a test may point at files on disk too.
const LocalChannels = schema(/^(?:https|file)$/)

export type Release = NonNullable<z.output<typeof Channels>["stable"]>
export type Platform = keyof Release["assets"]
export type Channels = z.output<typeof Channels>
export type ChannelsResult = { ok: true; channels: Channels } | { ok: false; problem: string }

export function parseChannels(text: string, local = false): ChannelsResult {
  const json = parseJson(text)
  if (!json.ok) return { ok: false, problem: "channels.json is not valid JSON" }
  const parsed = (local ? LocalChannels : Channels).safeParse(json.value)
  if (parsed.success) return { ok: true, channels: parsed.data }
  const issue = parsed.error.issues[0]
  return { ok: false, problem: `channels.json: ${issue?.path.join(".") || "file"}: ${issue?.message ?? "invalid"}` }
}
