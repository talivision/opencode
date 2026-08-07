import type { ToolPart } from "@opencode-ai/sdk/v2"
import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { goalDuration } from "../context/goal"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { errorMessage } from "../util/error"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { Spinner } from "./spinner"

export function DialogRunningTasks(props: { tasks: ToolPart[] }) {
  const sync = useSync()
  const route = useRoute()
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const [now, setNow] = createSignal(Date.now())
  const [toStop, setToStop] = createSignal<string>()
  const [stopped, setStopped] = createSignal(new Set<string>())
  const [stopping, setStopping] = createSignal(new Set<string>())
  // A memo, not a plain expression: props.tasks is reactive, and evaluating it
  // once in the component body froze the list at the moment the dialog opened,
  // so a task that started or finished while it was open never appeared or
  // disappeared. The pre-extraction version was reactive; this restores that.
  const tasks = createMemo(() =>
    props.tasks
    .flatMap((part) => {
      if (part.state.status === "pending") return []
      const sessionID = part.state.metadata?.sessionId
      if (typeof sessionID !== "string") return []
      return [
        {
          sessionID,
          title: sync.session.get(sessionID)?.title ?? taskDescription(part) ?? "Subagent",
          modelID: typeof part.state.metadata?.modelID === "string" ? part.state.metadata.modelID : "unknown model",
          start: part.state.time.start,
        },
      ]
    })
    .filter((task, index, all) => all.findIndex((item) => item.sessionID === task.sessionID) === index),
  )

  const options = createMemo<DialogSelectOption<string>[]>(() =>
    tasks().map((task) => {
      const isStopped = stopped().has(task.sessionID)
      const busy = !isStopped && sync.data.session_status[task.sessionID]?.type === "busy"
      return {
        title: toStop() === task.sessionID ? "Press ctrl+d again to stop" : task.title,
        value: task.sessionID,
        description: isStopped
          ? "stopped"
          : `${task.modelID} · ${goalDuration(Math.max(0, now() - task.start))} · ${busy ? "busy" : "idle"}`,
        bg: toStop() === task.sessionID ? theme.error : undefined,
        gutter: isStopped
          ? () => <text fg={theme.textMuted}>■</text>
          : busy
            ? () => <Spinner />
            : () => <text fg={theme.success}>✓</text>,
      }
    }),
  )

  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <DialogSelect
      title="Running tasks"
      options={options()}
      onMove={() => setToStop(undefined)}
      onSelect={(option) => {
        route.navigate({ type: "session", sessionID: option.value })
        dialog.clear()
      }}
      actions={[
        {
          command: "task.stop",
          title: "stop",
          disabled: (option) =>
            !option ||
            stopped().has(option.value) ||
            stopping().has(option.value) ||
            sync.data.session_status[option.value]?.type !== "busy",
          onTrigger: (option) => {
            if (toStop() !== option.value) {
              setToStop(option.value)
              return
            }

            setToStop(undefined)
            setStopping((current) => new Set(current).add(option.value))
            void sdk.client.session
              .abort({ sessionID: option.value }, { throwOnError: true })
              .then(() => {
                setStopping((current) => without(current, option.value))
                setStopped((current) => new Set(current).add(option.value))
                toast.show({ variant: "success", message: "Task stopped" })
              })
              .catch((error) => {
                setStopping((current) => without(current, option.value))
                toast.show({
                  variant: "error",
                  title: "Failed to stop task",
                  message: errorMessage(error),
                })
              })
          },
        },
      ]}
    />
  )
}

function taskDescription(part: ToolPart) {
  return typeof part.state.input.description === "string" ? part.state.input.description : undefined
}

function without(values: Set<string>, value: string) {
  const next = new Set(values)
  next.delete(value)
  return next
}
