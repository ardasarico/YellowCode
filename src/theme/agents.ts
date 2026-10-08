const SHAPES = ["◆", "▲", "■", "★", "▼"]

export function agentIdentity(index: number): { shape: string; color: number } {
  return { shape: SHAPES[index % SHAPES.length] ?? "◆", color: (index + Math.floor(index / 5)) % 5 }
}
