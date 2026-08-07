import { TextAttributes } from "@opentui/core"
import { Match, Show, Switch } from "solid-js"
import { useLocal } from "../../context/local"
import { useTheme } from "../../context/theme"
import { useOpencodeKeymap } from "../../keymap"

export function PermissionBadge(props: { mode: "normal" | "shell" }) {
  const local = useLocal()
  const { theme } = useTheme()
  const keymap = useOpencodeKeymap()

  return (
    <Show
      when={props.mode === "normal" && (local.agent.current()?.name === "plan" || local.permission.mode === "auto")}
    >
      <box flexDirection="row" onMouseUp={() => keymap.dispatchCommand("permission.cycle")}>
        <Switch>
          <Match when={local.agent.current()?.name === "plan"}>
            <text fg={theme.info}>⏸ plan mode on</text>
          </Match>
          <Match when={local.permission.mode === "auto"}>
            <text fg={theme.warning} attributes={TextAttributes.BOLD}>
              ⏵⏵ auto-approve on
            </text>
          </Match>
        </Switch>
        <text fg={theme.textMuted}> (shift+tab to cycle)</text>
      </box>
    </Show>
  )
}
