import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import type { PromptInfo } from "../prompt/history"
import { useTuiStartup } from "./runtime"

export type HomeRoute = {
  type: "home"
  prompt?: PromptInfo
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  prompt?: PromptInfo
}

export type PluginRoute = {
  type: "plugin"
  id: string
  data?: Record<string, unknown>
}

export type Route = HomeRoute | SessionRoute | PluginRoute

// Survives a watchdog remount: the whole provider tree is rebuilt after a dead
// render graph, and without this stash the user would land on home mid-session.
// Module state resets per process, so a fresh boot is unaffected.
let lastRoute: Route | undefined

export const { use: useRoute, provider: RouteProvider } = createSimpleContext({
  name: "Route",
  init: (props: { initialRoute?: Route; restoreStash?: boolean }) => {
    const startup = useTuiStartup()
    const [store, setStore] = createStore<Route>(
      (props.restoreStash ? lastRoute : undefined) ??
        props.initialRoute ??
        initialRoute(startup.initialRoute) ?? { type: "home" },
    )
    lastRoute = JSON.parse(JSON.stringify(store))

    return {
      get data() {
        return store
      },
      navigate(route: Route) {
        lastRoute = JSON.parse(JSON.stringify(route))
        setStore(reconcile(route))
      },
    }
  },
})

function initialRoute(value: unknown): Route | undefined {
  if (!value || typeof value !== "object" || !("type" in value)) return
  if (value.type === "home") return { type: "home" }
  if (value.type === "session" && "sessionID" in value && typeof value.sessionID === "string") {
    return { type: "session", sessionID: value.sessionID }
  }
  if (value.type === "plugin" && "id" in value && typeof value.id === "string") {
    return { type: "plugin", id: value.id }
  }
}

export type RouteContext = ReturnType<typeof useRoute>

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}
