import type { TuiPluginApi, TuiSlotContext, TuiSlotMap, TuiSlotProps } from "@opencode-ai/plugin/tui"
import { createSlot, createSolidSlotRegistry, type JSX, type SolidPlugin } from "@opentui/solid"
import { createSignal } from "solid-js"
import { isRecord } from "../util/record"

type RuntimeSlotMap = TuiSlotMap<Record<string, object>>
type SlotView = <Name extends string>(props: TuiSlotProps<Name>) => JSX.Element | null

export type HostSlotPlugin<Slots extends Record<string, object> = {}> = SolidPlugin<TuiSlotMap<Slots>, TuiSlotContext>
export type HostPluginApi = TuiPluginApi
export type HostSlots = {
  register: {
    (plugin: HostSlotPlugin): () => void
    <Slots extends Record<string, object>>(plugin: HostSlotPlugin<Slots>): () => void
  }
  dispose: () => void
}

function isHostSlotPlugin(value: unknown): value is HostSlotPlugin<Record<string, object>> {
  if (!isRecord(value)) return false
  if (typeof value.id !== "string") return false
  return isRecord(value.slots)
}

const slotContexts = new WeakMap<object, TuiSlotContext>()

export function createSlots() {
  const empty: SlotView = () => null
  const [view, setView] = createSignal<SlotView>(empty)
  // The view() read must live in a tracked JSX expression, not the component
  // body (Solid untracks component bodies): a Slot rendered before the plugin
  // host finishes loading — e.g. a session restored immediately after a
  // watchdog remount — would otherwise latch the empty view forever and
  // silently drop its children.
  const Slot: SlotView = (props) => <>{view()(props)}</>

  return {
    Slot,
    setup(api: HostPluginApi): HostSlots {
      // opentui keeps one slot registry per renderer and requires the SAME
      // context object on every createSolidSlotRegistry call for that
      // renderer. A watchdog remount re-runs setup with a fresh theme, so the
      // context object is cached per renderer and refreshed in place — a new
      // object here throws and silently kills every Slot's children.
      let context = slotContexts.get(api.renderer)
      if (!context) {
        context = { theme: api.theme }
        slotContexts.set(api.renderer, context)
      } else {
        context.theme = api.theme
      }
      const registry = createSolidSlotRegistry<RuntimeSlotMap, TuiSlotContext>(
        api.renderer,
        context,
        {
          onPluginError(event) {
            console.error("[tui.slot] plugin error", {
              plugin: event.pluginId,
              slot: event.slot,
              phase: event.phase,
              source: event.source,
              message: event.error.message,
            })
          },
        },
      )
      const slot = createSlot<RuntimeSlotMap, TuiSlotContext>(registry)
      setView(() => (props: TuiSlotProps<string>) => slot(props))

      return {
        register(plugin: HostSlotPlugin) {
          if (!isHostSlotPlugin(plugin)) return () => {}
          return registry.register(plugin)
        },
        dispose() {
          setView(() => empty)
        },
      }
    },
    clear() {
      setView(() => empty)
    },
  }
}
