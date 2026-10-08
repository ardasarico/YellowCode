export type Turn = {
  text: string
  image?: boolean
  interruptAfterFirstText?: boolean
}

export type Scenario = {
  name: string
  files?: Record<string, string>
  turns: Turn[]
}

export const scenarios: Scenario[] = [
  {
    name: "chat",
    turns: [
      {
        text: "Explain the difference between a process and a thread. Use a heading, a bulleted list, a small table, and one short TypeScript code block.",
      },
      { text: "Now summarize that in one sentence." },
    ],
  },
  {
    name: "tools",
    files: { "src/config.ts": "export const PORT = 3000\n" },
    turns: [
      {
        text: "Read src/config.ts, change it so the port comes from the PORT environment variable with 3000 as the fallback, then run `cat src/config.ts` with Bash to show the result.",
      },
    ],
  },
  {
    name: "permission",
    turns: [{ text: "Use the Write tool to create notes.txt containing 'hello'. Do nothing else." }],
  },
  {
    name: "subagent",
    files: { "README.md": "# Demo\n", "src/index.ts": "console.log('hi')\n" },
    turns: [
      {
        text: "Use the Agent tool with subagent_type general-purpose to list the files in this directory and report back. When it is done, reply with one sentence.",
      },
    ],
  },
  {
    name: "agents",
    files: { "README.md": "# Demo\n\nA tiny demo project.\n", "src/index.ts": "console.log('hi')\n" },
    turns: [
      {
        text: "In a single message, launch three general-purpose agents in parallel with the Agent tool, giving each a name: 'readme' reads README.md and summarizes it in one sentence, 'source' reads src/index.ts and says what it prints, and 'missing' reads docs/missing.md and reports what happened. Wait for all three, then reply with one sentence per agent.",
      },
    ],
  },
  {
    name: "image",
    turns: [{ text: "What color is the square in this image? Answer in one sentence.", image: true }],
  },
  {
    name: "long",
    turns: [
      {
        text: "Write a detailed guide (about 1500 words) to error handling in TypeScript with several headings, bulleted lists, and at least five code blocks.",
      },
    ],
  },
  {
    name: "markdown",
    turns: [
      {
        text: "Without using any tools, write a short markdown sample that contains: an H1, an H2 and an H3 heading; a nested bulleted list three levels deep; a numbered list; a task list with two checked and two unchecked items; a table with 5 columns and 4 rows; a markdown link; a bare URL; a 40-character hex hash in inline code; a blockquote; a horizontal rule; and a TypeScript code block that has one line of about 90 characters.",
      },
    ],
  },
  {
    name: "error",
    turns: [
      { text: "Run `cat does-not-exist.txt` with Bash and tell me what happened in one sentence." },
      { text: "Write a story of at least 800 words about a lighthouse keeper.", interruptAfterFirstText: true },
    ],
  },
  {
    name: "thinking",
    turns: [
      { text: "Think it through step by step before answering: is 1001 a prime number? Answer in one sentence." },
    ],
  },
]
