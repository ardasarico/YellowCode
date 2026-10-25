export type Change = { letter: string; path: string; added: number | null; removed: number | null }
export type GitState = { branch: string; changes: Change[] }

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" })
  const out = await new Response(child.stdout).text()
  return { ok: (await child.exited) === 0, out }
}

// "## main...origin/main [ahead 1]", "## No commits yet on main" or "## HEAD (no branch)".
function branchOf(header: string): string {
  const name = header.replace(/^## (No commits yet on )?/, "").split("...")[0] ?? ""
  return name.startsWith("HEAD ") ? "detached" : name
}

// Line counts by path from `git diff --numstat -z`; a rename is "added\tremoved\t" then the old and the new path.
function numstat(out: string): Map<string, { added: number | null; removed: number | null }> {
  const counts = new Map<string, { added: number | null; removed: number | null }>()
  const fields = out.split("\0")
  for (let index = 0; index < fields.length; index++) {
    const [added, removed, path] = (fields[index] ?? "").split("\t")
    if (added === undefined || removed === undefined || path === undefined) continue
    const to = path === "" ? fields[(index += 2)] : path
    // Binary files count "-".
    if (to)
      counts.set(to, { added: added === "-" ? null : Number(added), removed: removed === "-" ? null : Number(removed) })
  }
  return counts
}

// Null outside a git repo. Untracked files are left out.
export async function readState(cwd: string): Promise<GitState | null> {
  const status = await git(cwd, ["status", "--porcelain=v1", "-b", "-z", "--untracked-files=no"])
  if (!status.ok) return null
  const diff = await git(cwd, ["diff", "--numstat", "-z", "HEAD"])
  const counts = numstat(diff.ok ? diff.out : "")
  const fields = status.out.split("\0")
  const branch = branchOf(fields[0] ?? "")
  const changes: Change[] = []
  for (let index = 1; index < fields.length; index++) {
    const field = fields[index] ?? ""
    if (field.length < 4) continue
    const code = field.slice(0, 2)
    const path = field.slice(3)
    // A rename's old path follows in its own field.
    if (code.includes("R") || code.includes("C")) index++
    const letter = code[0] === " " ? (code[1] ?? "?") : (code[0] ?? "?")
    changes.push({ letter, path, ...(counts.get(path) ?? { added: null, removed: null }) })
  }
  return { branch, changes }
}

// The file's changes against HEAD, staged and unstaged together; before the first commit, what is staged.
export async function fileDiff(cwd: string, path: string): Promise<string> {
  const diff = await git(cwd, ["diff", "HEAD", "--", path])
  return diff.ok ? diff.out : (await git(cwd, ["diff", "--cached", "--", path])).out
}
