import packageJson from "../package.json"

declare const BUILD_VERSION: string
declare const BUILD_COMMIT: string
declare const BUILD_CHANNEL: string

// tools/build.ts defines these for a standalone binary; a run from source has none. A stable release is built from
// its beta's commit, so the version comes from the build, not from package.json.
export const appVersion: string = typeof BUILD_VERSION === "string" ? BUILD_VERSION : packageJson.version
export const buildCommit: string | null = typeof BUILD_COMMIT === "string" ? BUILD_COMMIT : null
export const buildChannel: string | null = typeof BUILD_CHANNEL === "string" ? BUILD_CHANNEL : null
export const compiled = buildChannel !== null
