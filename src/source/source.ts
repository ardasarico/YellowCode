// `at` is wall-clock time in epoch milliseconds.
export type SourceEvent = { dir: "in" | "out"; line: string; at: number }

export interface Source {
  events: AsyncIterable<SourceEvent>
  // False when the line was dropped because nothing reads it any more.
  send(line: string): boolean
  close(): void
}
