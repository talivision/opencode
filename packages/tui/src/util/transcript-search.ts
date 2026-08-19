import type { Message, Part, TextPart } from "@opencode-ai/sdk/v2"

export type TranscriptMatch = {
  messageID: string
  partID?: string
  preview: string
}

export type TranscriptHighlightSegment = {
  text: string
  match: boolean
}

export function segmentTranscriptMatches(text: string, query: string) {
  if (!query) return [{ text, match: false }]
  const source = text.toLowerCase()
  const needle = query.toLowerCase()
  const first = source.indexOf(needle)
  if (first === -1) return [{ text, match: false }]

  const segments: TranscriptHighlightSegment[] = []
  let offset = 0
  let index = first
  while (index !== -1) {
    if (index > offset) segments.push({ text: text.slice(offset, index), match: false })
    segments.push({ text: text.slice(index, index + query.length), match: true })
    offset = index + query.length
    index = source.indexOf(needle, offset)
  }
  if (offset < text.length) segments.push({ text: text.slice(offset), match: false })
  return segments
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
