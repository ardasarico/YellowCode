import { realpathSync } from "node:fs"

// Recorders work under /tmp, not the per-user temp folder: its path holds "_", which the project-key scrub mangles.
// macOS keeps /tmp at /private/tmp.
export const TMP = realpathSync("/tmp")
