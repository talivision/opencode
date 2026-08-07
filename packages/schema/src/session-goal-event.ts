export * as SessionGoalEvent from "./session-goal-event"

import { Schema } from "effect"
import { Event } from "./event"
import { NonNegativeInt } from "./schema"
import { SessionID } from "./session-id"

export const Completed = Event.define({
  type: "session.goal.completed",
  schema: {
    sessionID: SessionID,
  },
})

export const Blocked = Event.define({
  type: "session.goal.blocked",
  schema: {
    sessionID: SessionID,
    reason: Schema.String,
  },
})

export const Paused = Event.define({
  type: "session.goal.paused",
  schema: {
    sessionID: SessionID,
    reason: Schema.Literal("budget"),
    tokensUsed: NonNegativeInt,
    tokenBudget: NonNegativeInt,
  },
})

export const Definitions = Event.inventory(Completed, Blocked, Paused)
