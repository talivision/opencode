import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
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
  const [now, setNow] = createSignal(Date.now())

  const elapsed = createMemo(() => {
    const current = goal()
    if (!current) return 0
    return (
      current.time.elapsed +
      (current.status === "active" && current.time.running ? Math.max(0, now() - current.time.running) : 0)
    )
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
    const timer = setInterval(() => {
      setNow(Date.now())
      void goals.refresh(props.sessionID)
    }, 1000)
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
            ◎ Goal {current().status} · {goalDuration(elapsed())} · {Locale.number(current().turns)} turn
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
