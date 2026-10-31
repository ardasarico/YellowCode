declare const BUILD_COMMIT: string
declare const BUILD_CHANNEL: string

// tools/build.ts defines both for a standalone binary; a run from source has neither.
export const buildCommit: string | null = typeof BUILD_COMMIT === "string" ? BUILD_COMMIT : null
export const buildChannel: string | null = typeof BUILD_CHANNEL === "string" ? BUILD_CHANNEL : null
export const compiled = buildChannel !== null
