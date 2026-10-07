export type SourceEvent = { dir: "in" | "out"; line: string }

export interface Source {
  events: AsyncIterable<SourceEvent>
  send(line: string): void
  close(): void
}
