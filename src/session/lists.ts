import type { McpServer, Session, SessionInfo } from "./types.ts"

// The newest server list: claude's own report after init (live), else init's, else what stands in for init.
export function currentServers(session: Session, fallback: SessionInfo | null): McpServer[] | null {
  return session.mcpServers ?? session.info?.mcpServers ?? fallback?.mcpServers ?? null
}

export function currentInfo(session: Session, fallback: SessionInfo | null): SessionInfo | null {
  const info = session.info ?? fallback
  if (!info) return null
  return {
    ...info,
    mcpServers: session.mcpServers ?? info.mcpServers,
    plugins: session.plugins ?? info.plugins,
  }
}
