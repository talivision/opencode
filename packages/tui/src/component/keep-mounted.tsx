import type { JSX } from "@opentui/solid"

export function KeepMounted(props: { visible: boolean; children: JSX.Element }) {
  return (
    <box visible={props.visible} height={props.visible ? "auto" : 0} overflow="hidden" flexShrink={0}>
      {props.children}
    </box>
  )
}
