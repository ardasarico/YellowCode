export type OutgoingImage = {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"
  base64: string
}

export function userMessage(text: string, images: OutgoingImage[] = []): string {
  const content =
    images.length === 0
      ? text
      : [
          ...images.map((image) => ({
            type: "image",
            source: { type: "base64", media_type: image.mediaType, data: image.base64 },
          })),
          { type: "text", text },
        ]
  return JSON.stringify({ type: "user", parent_tool_use_id: null, message: { role: "user", content } })
}

export function allowTool(requestId: string, input: unknown): string {
  return JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response: { behavior: "allow", updatedInput: input } },
  })
}

export function interruptRequest(requestId: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } })
}
