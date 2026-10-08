export type SourceEvent = { dir: "in" | "out"; line: string; at: number }

export interface Source {
  events: AsyncIterable<SourceEvent>
  send(line: string): void
  close(): void
}
