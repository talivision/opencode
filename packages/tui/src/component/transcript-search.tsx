import { TextAttributes, type InputRenderable } from "@opentui/core"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useTuiConfig } from "../config"
import { useTheme } from "../context/theme"
import { useBindings, useOpencodeModeStack } from "../keymap"
import { createDebouncedSignal } from "../util/signal"
import { findMatches } from "../util/transcript-search"

const TRANSCRIPT_SEARCH_MODE = "transcript-search"

export type TranscriptSearchRef = {
  focus(): void
}

export function TranscriptSearch(props: {
  messages: Message[]
  partsByMessage: Record<string, Part[]>
  jumpTo: (id: string) => void
  onClose: () => void
  onMatch?: (match: { id: string | undefined; query: string }) => void
  ref?: (ref: TranscriptSearchRef | undefined) => void
}) {
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const modeStack = useOpencodeModeStack()
  const [query, setQuery] = createDebouncedSignal("", 150)
  const [selected, setSelected] = createSignal(-1)
  const matches = createMemo(() => findMatches(props.messages, props.partsByMessage, query()))
  let input: InputRenderable | undefined

  const focus = () => {
    if (!input || input.isDestroyed) return
    input.focus()
  }

  props.ref?.({ focus })
  onCleanup(() => props.ref?.(undefined))

  onMount(() => {
    const popMode = modeStack.push(TRANSCRIPT_SEARCH_MODE)
    onCleanup(popMode)
  })

  const select = (index: number) => {
    setSelected(index)
    const match = matches()[index]
    const id = match ? (match.partID ?? match.messageID) : undefined
    props.onMatch?.({ id, query: query() })
    if (id) props.jumpTo(id)
  }

  createEffect(() => select(matches().length - 1))
  onCleanup(() => props.onMatch?.({ id: undefined, query: "" }))

  const move = (direction: -1 | 1) => {
    const total = matches().length
    if (!total) return
    const current = selected() < 0 ? total - 1 : Math.min(selected(), total - 1)
    const index = (current + direction + total) % total
    select(index)
  }

  useBindings(() => ({
    mode: TRANSCRIPT_SEARCH_MODE,
    enabled: true,
    commands: [],
    bindings: [
      {
        key: "escape",
        desc: "Close transcript search",
        group: "Session",
        cmd: props.onClose,
      },
      {
        key: "return",
        desc: "Previous transcript match",
        group: "Session",
        cmd: () => move(-1),
      },
      {
        key: "up",
        desc: "Previous transcript match",
        group: "Session",
        cmd: () => move(-1),
      },
      {
        key: "down",
        desc: "Next transcript match",
        group: "Session",
        cmd: () => move(1),
      },
      ...tuiConfig.keybinds.get("session.search"),
    ],
  }))

  const counter = createMemo(() => {
    const total = matches().length
    if (!total) return "no matches"
    return `${(selected() < 0 ? total - 1 : Math.min(selected(), total - 1)) + 1}/${total}`
  })

  return (
    <box
      flexDirection="row"
      alignItems="center"
      gap={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme.backgroundPanel}
    >
      <text fg={theme.primary} attributes={TextAttributes.BOLD}>
        Find
      </text>
      <input
        flexGrow={1}
        onInput={setQuery}
        focusedBackgroundColor={theme.backgroundPanel}
        cursorColor={theme.primary}
        focusedTextColor={theme.text}
        ref={(value) => {
          input = value
          input.traits = { status: "FILTER" }
          setTimeout(focus, 1)
        }}
        placeholder="Find in transcript"
        placeholderColor={theme.textMuted}
      />
      <text fg={matches().length ? theme.text : theme.textMuted}>{counter()}</text>
      <text fg={theme.textMuted}>enter/up older · down newer · esc close</text>
    </box>
  )
}
