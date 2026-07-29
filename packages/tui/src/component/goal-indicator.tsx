import { createMemo, onCleanup, onMount, Show } from "solid-js"
import { useGoal, goalDuration } from "../context/goal"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogGoal } from "./dialog-goal"
import { Locale } from "../util/locale"

export function GoalIndicator(props: { sessionID: string }) {
  const goals = useGoal()
  const goal = goals.get(props.sessionID)
  const { theme } = useTheme()
  const dialog = useDialog()

  const paused = createMemo(() => (goal()?.pauseReason === "budget" ? " (token budget reached)" : ""))

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
            wrapMode="word"
          >
            ◎ Goal {current().status}
            {paused()} · {goalDuration(current().time.elapsed)} · {Locale.number(current().turns)} turn
            {current().turns === 1 ? "" : "s"} · {Locale.number(current().tokensUsed)} tokens{review()}
            <span style={{ fg: theme.textMuted }}> · /goal</span>
          </text>
          <text fg={theme.textMuted} wrapMode="word">
            {current().objective}
          </text>
        </box>
      )}
    </Show>
  )
}
