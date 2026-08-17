import type { Message, Part, TextPart } from "@opencode-ai/sdk/v2"

export type TranscriptMatch = {
  messageID: string
  partID?: string
  preview: string
}

export function findMatches(messages: Message[], partsByMessage: Record<string, Part[]>, query: string) {
  if (!query) return []
  const needle = query.toLowerCase()

  return messages.flatMap((message): TranscriptMatch[] => {
    const parts = partsByMessage[message.id] ?? []
    if (message.role === "user") {
      const preview = parts
        .filter((part): part is TextPart => part.type === "text" && !part.synthetic && !part.ignored)
        .map((part) => part.text)
        .join("\n\n")
      if (!preview.toLowerCase().includes(needle)) return []
      return [{ messageID: message.id, preview }]
    }

    return parts
      .filter((part): part is TextPart => part.type === "text")
      .filter((part) => part.text.toLowerCase().includes(needle))
      .map((part) => ({ messageID: message.id, partID: part.id, preview: part.text }))
  })
}
