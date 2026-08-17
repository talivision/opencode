import { createMemo, onCleanup, onMount, Show } from "solid-js"
import { useGoal, goalDuration } from "../context/goal"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogGoal } from "./dialog-goal"
import { Locale } from "../util/locale"
import { useTerminalDimensions } from "@opentui/solid"
import { useTuiConfig } from "../config"
import { useCommandShortcut } from "../keymap"

export function GoalIndicator(props: { sessionID: string; minimized: boolean }) {
  const goals = useGoal()
  const goal = goals.get(props.sessionID)
  const { theme } = useTheme()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const shortcut = useCommandShortcut("goal.minimize")
  const maxHeight = createMemo(() => tuiConfig.goal?.max_height ?? Math.max(3, Math.floor(dimensions().height / 4)))

  const paused = createMemo(() => {
    if (goal()?.pauseReason === "budget") return " (token budget reached)"
    if (goal()?.pauseReason === "interrupted") return " (interrupted — /goal resume)"
    return ""
  })
  const minimized = createMemo(() => {
    const status = goal()?.status
    return props.minimized || (status !== "active" && status !== "paused")
  })

  const review = createMemo(() => {
    const status = goal()?.review?.status
    if (status === "pending" || status === "running") return ` · review ${status}`
    if (status === "rejected") return " · review rejected"
    if (status === "error") return " · review error"
    return ""
  })

  onMount(() => {
    void goals.refresh(props.sessionID)
    const timer = setInterval(() => void goals.refresh(props.sessionID), 1000)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <Show when={goal()}>
      {(current) => (
        <box
          flexShrink={0}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={theme.backgroundPanel}
          onMouseUp={() => dialog.replace(() => <DialogGoal sessionID={props.sessionID} />)}
        >
          <text
            fg={
              current().status === "complete"
                ? theme.success
                : current().status === "blocked"
                  ? theme.error
                  : current().status === "paused"
                    ? theme.warning
                    : theme.primary
            }
            wrapMode={minimized() ? "none" : "word"}
            truncate={minimized()}
          >
            ◎ Goal {current().status}
            {paused()} · {goalDuration(current().time.elapsed)} · {Locale.number(current().turns)} turn
            {current().turns === 1 ? "" : "s"} · {Locale.number(current().tokensUsed)} tokens{review()}
            <span style={{ fg: theme.textMuted }}>
              {minimized() ? ` · ${current().objective}` : ""} · /goal · {shortcut()}{" "}
              {minimized() ? "expand" : "minimize"}
            </span>
          </text>
          <Show when={!minimized()}>
            <text fg={theme.textMuted} wrapMode="word" maxHeight={maxHeight()}>
              {current().objective}
            </text>
          </Show>
        </box>
      )}
    </Show>
  )
}
