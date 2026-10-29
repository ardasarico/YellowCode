const MAX_KEY_LENGTH = 200

// The folder name Claude Code gives a project under ~/.claude/projects; the Claude adapter finds sessions by it, so it
// must stay the same.
export function projectKey(path: string): string {
  const key = path.replace(/[^A-Za-z0-9]/g, "-")
  if (key.length <= MAX_KEY_LENGTH) return key
  let hash = 0
  for (let i = 0; i < path.length; i++) hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0
  return `${key.slice(0, MAX_KEY_LENGTH)}-${Math.abs(hash).toString(36)}`
}
