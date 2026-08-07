import { TextAttributes } from "@opentui/core"
import { Match, Show, Switch } from "solid-js"
import { useLocal } from "../../context/local"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { useOpencodeKeymap } from "../../keymap"

export function PermissionBadge(props: { mode: "normal" | "shell"; sessionID?: string }) {
  const local = useLocal()
  const sync = useSync()
  const { theme } = useTheme()
  const keymap = useOpencodeKeymap()
  const auto = () => {
    if (!props.sessionID || !sync.data.capabilities.permissionAuto) return local.permission.mode === "auto"
    return sync.permissionAuto.get(props.sessionID)?.enabled ?? false
  }

  return (
    <Show when={props.mode === "normal" && (local.agent.current()?.name === "plan" || auto())}>
      <box flexDirection="row" onMouseUp={() => keymap.dispatchCommand("permission.cycle")}>
        <Switch>
          <Match when={local.agent.current()?.name === "plan"}>
            <text fg={theme.info}>⏸ plan mode on</text>
          </Match>
          <Match when={auto()}>
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
