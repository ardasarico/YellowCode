import { moveHome, moveLines } from "./move-home.ts"

// index.tsx imports this first: some modules read their files as they load (the themes do), and the move comes before.
export const movedLines = moveLines(moveHome())
