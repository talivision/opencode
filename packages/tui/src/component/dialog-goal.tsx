import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useGoal, goalDuration } from "../context/goal"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useToast } from "../ui/toast"
import { useBindings } from "../keymap"
import { Locale } from "../util/locale"
import { useRoute } from "../context/route"

export function DialogGoal(props: { sessionID: string }) {
  const goals = useGoal()
  const goal = goals.get(props.sessionID)
  const { theme } = useTheme()
  const dialog = useDialog()
  const route = useRoute()
  const toast = useToast()
  const [now, setNow] = createSignal(Date.now())
  const [busy, setBusy] = createSignal(false)

  const elapsed = createMemo(() => {
    const current = goal()
    if (!current) return 0
    return (
      current.time.elapsed +
      (current.status === "active" && current.time.running ? Math.max(0, now() - current.time.running) : 0)
    )
  })

  const run = async (input: string) => {
    if (busy()) return
    setBusy(true)
    await goals
      .execute(props.sessionID, input)
      .catch((error) => {
        toast.show({
          title: "Goal",
          message: error instanceof Error ? error.message : "Goal command failed",
          variant: "error",
        })
      })
      .finally(() => setBusy(false))
  }

  const edit = async () => {
    if (busy()) return
    const current = goal()
    const value = await DialogPrompt.show(dialog, current ? "Edit goal" : "Set goal", {
      value: current?.objective,
      placeholder: "--tokens 50000 objective",
      description: () => (
        <text fg={theme.textMuted}>
          Optional token budget: <span style={{ fg: theme.text }}>--tokens N</span>
        </text>
      ),
    })
    if (value === null || !value.trim()) {
      dialog.replace(() => <DialogGoal sessionID={props.sessionID} />)
      return
    }
    await run(current ? `edit ${value}` : value)
    dialog.replace(() => <DialogGoal sessionID={props.sessionID} />)
  }

  const toggle = async () => {
    const current = goal()
    if (!current || current.status === "complete") return
    await run(current.status === "active" ? "pause" : "resume")
  }

  const viewReviewer = () => {
    const sessionID = goal()?.review?.reviewerSessionID
    if (!sessionID) return
    dialog.clear()
    route.navigate({ type: "session", sessionID })
  }

  useBindings(() => ({
    enabled: !busy(),
    bindings: [
      { key: "e", desc: "Edit goal", group: "Goal", cmd: edit },
      { key: "s", desc: "Set goal", group: "Goal", cmd: edit },
      { key: "p", desc: "Pause or resume goal", group: "Goal", cmd: toggle },
      { key: "c", desc: "Clear goal", group: "Goal", cmd: () => run("clear") },
      { key: "r", desc: "Refresh goal", group: "Goal", cmd: () => goals.refresh(props.sessionID) },
      { key: "v", desc: "View reviewer", group: "Goal", cmd: viewReviewer },
    ],
  }))

  onMount(() => {
    dialog.setSize("large")
    void goals.refresh(props.sessionID)
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Goal
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show
        when={goal()}
        fallback={
          <box gap={1}>
            <text fg={theme.text}>No goal set</text>
            <text fg={theme.textMuted}>Use /goal &lt;objective&gt; or press s to set one.</text>
          </box>
        }
      >
        {(current) => (
          <box gap={1}>
            <box flexDirection="row" gap={1}>
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
                attributes={TextAttributes.BOLD}
              >
                {current().status.toUpperCase()}
              </text>
              <text fg={theme.textMuted}>
                {goalDuration(elapsed())} · {Locale.number(current().turns)} turn
                {current().turns === 1 ? "" : "s"} · {Locale.number(current().tokensUsed)} tokens
              </text>
            </box>
            <text fg={theme.text} wrapMode="word">
              {current().objective}
            </text>
            <Show when={current().tokenBudget !== undefined}>
              <text fg={theme.textMuted}>Token budget: {Locale.number(current().tokenBudget!)}</text>
            </Show>
            <Show when={current().blocker}>
              {(blocker) => (
                <text fg={theme.warning} wrapMode="word">
                  Blocker {blocker().count}/3: {blocker().reason}
                </text>
              )}
            </Show>
            <Show when={current().review}>
              {(review) => (
                <box>
                  <text fg={review().status === "accepted" ? theme.success : theme.textMuted}>
                    Independent review #{review().attempt}: {review().status}
                  </text>
                  <Show when={review().reason}>
                    <text fg={theme.textMuted} wrapMode="word">
                      {review().reason}
                    </text>
                  </Show>
                </box>
              )}
            </Show>
          </box>
        )}
      </Show>
      <box flexDirection="row" gap={2} paddingTop={1}>
        <text fg={theme.text} onMouseUp={edit}>
          <span style={{ fg: theme.primary }}>e</span> {goal() ? "edit" : "set"}
        </text>
        <Show when={goal() && goal()!.status !== "complete"}>
          <text fg={theme.text} onMouseUp={toggle}>
            <span style={{ fg: theme.primary }}>p</span> {goal()!.status === "active" ? "pause" : "resume"}
          </text>
        </Show>
        <Show when={goal()}>
          <text fg={theme.text} onMouseUp={() => run("clear")}>
            <span style={{ fg: theme.primary }}>c</span> clear
          </text>
        </Show>
        <Show when={goal()?.review?.reviewerSessionID}>
          <text fg={theme.text} onMouseUp={viewReviewer}>
            <span style={{ fg: theme.primary }}>v</span> view reviewer
          </text>
        </Show>
        <text fg={theme.text} onMouseUp={() => goals.refresh(props.sessionID)}>
          <span style={{ fg: theme.primary }}>r</span> refresh
        </text>
      </box>
    </box>
  )
}
