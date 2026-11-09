import { OWN_ASK_SERVER } from "../protocol/messages.ts"

// claude's own limit on a call to our server. The user may take as long as they like over an ask.
export const OWN_ASK_TIMEOUT_MS = 1e12

export const OWN_ASK_DESCRIPTION =
  "Use this tool instead of AskUserQuestion, and wherever instructions say AskUserQuestion. Ask the user questions " +
  "and wait for the answers. Prefer this over guessing whenever a choice is the user's to make. The user never sees " +
  "your thinking or your tool results: anything a question points at, such as a plan, summary, research findings, " +
  "list or image, must already be written in your reply above this call. `questions`: one or more pages, each a " +
  "question with a short `header` and 2–4 options (`label`, optional `description` only when the label needs it)." +
  ' Put the recommended option first and end its label with "(Recommended)". Set ' +
  "`multiSelect` when several answers can be true. An option may carry `image`, a PNG, JPG or SVG file path, shown " +
  "beside the list: use it when a picture explains the option better than words. Set `gallery: true` on a page to " +
  "show 2–4 designs side by side when the choice is between visual directions; every option then needs an image. " +
  "`matrix` instead of `questions`: several short propositions answered on one shared scale (2–4 steps, ending in " +
  'an uncertainty step such as "Unsure"); ask the rows answered with it again later, one by one. The user can ' +
  "always type their own answer and add a note; `[Image N: path]` in an answer or note is a picture they pasted, " +
  "so read that file."

// The API takes no oneOf at the top level, so both keys are optional and ownAskProblem wants exactly one.
export const OWN_ASK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["question", "header", "options"],
        properties: {
          question: { type: "string" },
          header: { type: "string", description: "A short label for the page bar." },
          multiSelect: { type: "boolean" },
          gallery: { type: "boolean" },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: {
              type: "object",
              required: ["label"],
              properties: {
                label: { type: "string" },
                description: { type: "string" },
                image: {
                  type: "string",
                  description: "Path of a PNG, JPG or SVG file, absolute or relative to the project.",
                },
              },
            },
          },
        },
      },
    },
    matrix: {
      type: "object",
      required: ["question", "header", "rows", "scale"],
      properties: {
        question: { type: "string" },
        header: { type: "string" },
        rows: {
          type: "array",
          minItems: 2,
          items: { type: "object", required: ["label"], properties: { label: { type: "string" } } },
        },
        scale: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } },
      },
    },
  },
}

// alwaysLoad keeps the tool out of ToolSearch; readOnlyHint lets it run in plan mode without a permission ask.
export const OWN_ASK_TOOL = {
  name: "ask",
  description: OWN_ASK_DESCRIPTION,
  inputSchema: OWN_ASK_SCHEMA,
  annotations: { readOnlyHint: true },
  _meta: { "anthropic/alwaysLoad": true },
}

// What initialize declares, so claude asks us for the server's tools.
export const OWN_ASK_INIT = {
  sdkMcpServers: [OWN_ASK_SERVER],
  sdkMcpServerConfigs: { [OWN_ASK_SERVER]: { timeout: OWN_ASK_TIMEOUT_MS } },
}
