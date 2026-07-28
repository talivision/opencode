export * as SessionGoal from "./goal"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { Storage } from "@/storage/storage"
import { SessionID } from "./schema"

export const Status = Schema.Literals(["active", "paused", "complete", "blocked"])
export type Status = Schema.Schema.Type<typeof Status>

export const ReviewStatus = Schema.Literals(["pending", "running", "accepted", "rejected", "error"])
export type ReviewStatus = Schema.Schema.Type<typeof ReviewStatus>

const Review = Schema.Struct({
  status: ReviewStatus,
  attempt: NonNegativeInt,
  requestedAt: NonNegativeInt,
  updatedAt: NonNegativeInt,
  evidence: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  reviewerSessionID: Schema.optional(SessionID),
})

export const Info = Schema.Struct({
  sessionID: SessionID,
  objective: Schema.String,
  status: Status,
  tokenBudget: Schema.optional(NonNegativeInt),
  tokensUsed: NonNegativeInt,
  turns: NonNegativeInt,
  blocker: Schema.optional(
    Schema.Struct({
      reason: Schema.String,
      count: NonNegativeInt,
      turn: NonNegativeInt,
    }),
  ),
  pauseReason: Schema.optional(Schema.Literals(["user", "budget"])),
  review: Schema.optional(Review),
  time: Schema.Struct({
    created: NonNegativeInt,
    updated: NonNegativeInt,
    running: Schema.optional(NonNegativeInt),
    elapsed: NonNegativeInt,
    completed: Schema.optional(NonNegativeInt),
  }),
}).annotate({ identifier: "SessionGoal" })
export type Info = Schema.Schema.Type<typeof Info>

export const SetInput = Schema.Struct({
  sessionID: SessionID,
  objective: Schema.String,
  tokenBudget: Schema.optional(NonNegativeInt),
})
export type SetInput = Schema.Schema.Type<typeof SetInput>

export const EditInput = Schema.Struct({
  sessionID: SessionID,
  objective: Schema.String,
  tokenBudget: Schema.optional(NonNegativeInt),
})
export type EditInput = Schema.Schema.Type<typeof EditInput>

export const RecordTurnInput = Schema.Struct({
  sessionID: SessionID,
  tokens: NonNegativeInt,
})
export type RecordTurnInput = Schema.Schema.Type<typeof RecordTurnInput>

export const ReviewRequestInput = Schema.Struct({
  sessionID: SessionID,
  evidence: Schema.optional(Schema.String),
})
export type ReviewRequestInput = Schema.Schema.Type<typeof ReviewRequestInput>

export const ReviewFinishInput = Schema.Struct({
  sessionID: SessionID,
  reviewerSessionID: SessionID,
  accepted: Schema.Boolean,
  reason: Schema.String,
  tokens: NonNegativeInt,
  error: Schema.optional(Schema.Boolean),
})
export type ReviewFinishInput = Schema.Schema.Type<typeof ReviewFinishInput>

type MutableInfo = {
  -readonly [K in keyof Info]: K extends "time"
    ? {
        -readonly [T in keyof Info["time"]]: Info["time"][T]
      }
    : K extends "blocker"
      ?
          | {
              -readonly [B in keyof NonNullable<Info["blocker"]>]: NonNullable<Info["blocker"]>[B]
            }
          | undefined
      : K extends "review"
        ?
            | {
                -readonly [R in keyof NonNullable<Info["review"]>]: NonNullable<Info["review"]>[R]
              }
            | undefined
        : Info[K]
}

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly set: (input: SetInput) => Effect.Effect<Info>
  readonly edit: (input: EditInput) => Effect.Effect<Info | undefined>
  readonly pause: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly resume: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly block: (sessionID: SessionID, reason: string) => Effect.Effect<Info | undefined>
  readonly requestReview: (input: ReviewRequestInput) => Effect.Effect<Info | undefined>
  readonly beginReview: (sessionID: SessionID, reviewerSessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly recoverReview: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly finishReview: (input: ReviewFinishInput) => Effect.Effect<Info | undefined>
  readonly clear: (sessionID: SessionID) => Effect.Effect<boolean>
  readonly recordTurn: (input: RecordTurnInput) => Effect.Effect<Info | undefined>
  readonly context: (sessionID: SessionID) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoal") {}

function key(sessionID: SessionID) {
  return ["goal", sessionID]
}

function elapsed(info: Info, now = Date.now()) {
  return info.time.elapsed + (info.status === "active" && info.time.running ? Math.max(0, now - info.time.running) : 0)
}

function view(info: Info, now = Date.now()): Info {
  return {
    ...info,
    time: {
      ...info.time,
      elapsed: elapsed(info, now),
    },
  }
}

function stopClock(info: MutableInfo, now: number) {
  if (info.status === "active" && info.time.running) {
    info.time.elapsed += Math.max(0, now - info.time.running)
  }
  info.time.running = undefined
}

function objective(value: string) {
  const next = value.trim()
  if (!next) throw new Error("Goal objective cannot be empty")
  return next
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value)
}

function formatDuration(ms: number) {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return `${minutes}m ${rest}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const decode = Schema.decodeUnknownEffect(Info)

    const get = Effect.fn("SessionGoal.get")(function* (sessionID: SessionID) {
      const raw = yield* storage.read<unknown>(key(sessionID)).pipe(
        Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
        Effect.orDie,
      )
      if (raw === undefined) return
      return view(yield* decode(raw).pipe(Effect.orDie))
    })

    const write = Effect.fnUntraced(function* (info: Info) {
      yield* storage.write(key(info.sessionID), info).pipe(Effect.orDie)
      return view(info)
    })

    const update = Effect.fnUntraced(function* (
      sessionID: SessionID,
      mutate: (draft: MutableInfo, now: number) => void,
    ) {
      const now = Date.now()
      const result = yield* storage
        .update<MutableInfo>(key(sessionID), (draft) => {
          mutate(draft, now)
          draft.time.updated = now
        })
        .pipe(
          Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
          Effect.orDie,
        )
      if (!result) return
      return view(yield* decode(result).pipe(Effect.orDie), now)
    })

    const set = Effect.fn("SessionGoal.set")(function* (input: SetInput) {
      const now = Date.now()
      return yield* write({
        sessionID: input.sessionID,
        objective: objective(input.objective),
        status: "active",
        ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
        tokensUsed: 0,
        turns: 0,
        time: {
          created: now,
          updated: now,
          running: now,
          elapsed: 0,
        },
      })
    })

    const edit = Effect.fn("SessionGoal.edit")(function* (input: EditInput) {
      return yield* update(input.sessionID, (draft, now) => {
        stopClock(draft, now)
        draft.objective = objective(input.objective)
        if (input.tokenBudget !== undefined) draft.tokenBudget = input.tokenBudget
        draft.status = "active"
        draft.pauseReason = undefined
        draft.blocker = undefined
        draft.review = undefined
        draft.time.completed = undefined
        draft.time.running = now
      })
    })

    const pause = Effect.fn("SessionGoal.pause")(function* (sessionID: SessionID) {
      return yield* update(sessionID, (draft, now) => {
        if (draft.status !== "active") return
        stopClock(draft, now)
        draft.status = "paused"
        draft.pauseReason = "user"
      })
    })

    const resume = Effect.fn("SessionGoal.resume")(function* (sessionID: SessionID) {
      return yield* update(sessionID, (draft, now) => {
        if (draft.status === "active") return
        if (draft.status === "complete") return
        draft.status = "active"
        draft.pauseReason = undefined
        draft.blocker = undefined
        draft.time.completed = undefined
        draft.time.running = now
      })
    })

    const block = Effect.fn("SessionGoal.block")(function* (sessionID: SessionID, reason: string) {
      const text = reason.trim()
      if (!text) return yield* get(sessionID)
      return yield* update(sessionID, (draft, now) => {
        if (draft.status !== "active") return
        const turn = draft.turns + 1
        const same = draft.blocker?.reason === text
        const repeated = same && draft.blocker?.turn !== turn
        draft.blocker = {
          reason: text,
          count: repeated ? draft.blocker!.count + 1 : same ? draft.blocker!.count : 1,
          turn,
        }
        if (draft.blocker.count < 3) return
        stopClock(draft, now)
        draft.status = "blocked"
        draft.time.completed = now
      })
    })

    const requestReview = Effect.fn("SessionGoal.requestReview")(function* (input: ReviewRequestInput) {
      return yield* update(input.sessionID, (draft, now) => {
        if (draft.status !== "active") return
        const evidence = input.evidence?.trim()
        draft.review = {
          status: "pending",
          attempt: (draft.review?.attempt ?? 0) + 1,
          requestedAt: now,
          updatedAt: now,
          ...(evidence ? { evidence } : {}),
        }
      })
    })

    const beginReview = Effect.fn("SessionGoal.beginReview")(function* (
      sessionID: SessionID,
      reviewerSessionID: SessionID,
    ) {
      return yield* update(sessionID, (draft, now) => {
        if (draft.status === "complete" || draft.status === "blocked") return
        if (draft.review?.status !== "pending") return
        draft.review.status = "running"
        draft.review.updatedAt = now
        draft.review.reviewerSessionID = reviewerSessionID
      })
    })

    const recoverReview = Effect.fn("SessionGoal.recoverReview")(function* (sessionID: SessionID) {
      return yield* update(sessionID, (draft, now) => {
        if (draft.review?.status !== "running") return
        draft.review.status = "pending"
        draft.review.updatedAt = now
        draft.review.reason = "The previous independent review was interrupted and has been queued again."
        draft.review.reviewerSessionID = undefined
      })
    })

    const finishReview = Effect.fn("SessionGoal.finishReview")(function* (input: ReviewFinishInput) {
      return yield* update(input.sessionID, (draft, now) => {
        if (draft.review?.status !== "running") return
        if (draft.review.reviewerSessionID !== input.reviewerSessionID) return
        draft.tokensUsed += input.tokens
        draft.review.status = input.error ? "error" : input.accepted ? "accepted" : "rejected"
        draft.review.updatedAt = now
        draft.review.reason =
          input.reason.trim() || (input.accepted ? "Goal requirements verified." : "Goal not verified.")
        if (!input.accepted) return
        if (draft.status === "complete" || draft.status === "blocked") return
        stopClock(draft, now)
        draft.status = "complete"
        draft.blocker = undefined
        draft.pauseReason = undefined
        draft.time.completed = now
      })
    })

    const clear = Effect.fn("SessionGoal.clear")(function* (sessionID: SessionID) {
      const current = yield* get(sessionID)
      if (!current) return false
      yield* storage.remove(key(sessionID)).pipe(Effect.orDie)
      return true
    })

    const recordTurn = Effect.fn("SessionGoal.recordTurn")(function* (input: RecordTurnInput) {
      return yield* update(input.sessionID, (draft, now) => {
        draft.turns += 1
        draft.tokensUsed += input.tokens
        if (draft.blocker && draft.blocker.turn < draft.turns) {
          draft.blocker = undefined
        }
        if (draft.status === "active" && draft.tokenBudget !== undefined && draft.tokensUsed >= draft.tokenBudget) {
          stopClock(draft, now)
          draft.status = "paused"
          draft.pauseReason = "budget"
        }
      })
    })

    const context = Effect.fn("SessionGoal.context")(function* (sessionID: SessionID) {
      const info = yield* get(sessionID)
      if (info?.status !== "active") return
      const budget =
        info.tokenBudget === undefined
          ? "No token budget was set."
          : `Token budget: ${formatNumber(info.tokensUsed)} of ${formatNumber(info.tokenBudget)} used.`
      const blocker = info.blocker
        ? `The same blocker has been reported ${info.blocker.count} consecutive goal turn(s): ${info.blocker.reason}`
        : "No repeated blocker is currently recorded."
      const review =
        info.review?.status === "rejected" || info.review?.status === "error"
          ? `Independent review attempt ${info.review.attempt} did not accept completion: ${info.review.reason ?? "No valid reviewer verdict was produced."}`
          : info.review?.status === "pending" || info.review?.status === "running"
            ? `Independent review attempt ${info.review.attempt} is ${info.review.status}.`
            : "No independent completion review is pending."
      return [
        "<active-goal>",
        `Status: ${info.status}`,
        `Objective: ${info.objective}`,
        `Elapsed: ${formatDuration(info.time.elapsed)} across ${info.turns} completed goal turn(s).`,
        budget,
        blocker,
        review,
        "",
        "Keep the full objective intact and treat it as the task to pursue until it is genuinely achieved.",
        "Work autonomously and verify every explicit requirement against authoritative current-state evidence.",
        "Use the goal tool with status complete only when every requirement is achieved and no required work remains.",
        "A completion request is never self-certifying: an independent read-only reviewer will verify it before the goal can complete.",
        "If the reviewer rejects completion, address its concrete reason and gather stronger current-state evidence before requesting another review.",
        "Do not mark the goal complete based on intent, partial progress, a plausible answer, or because a budget is nearly exhausted.",
        "If work remains, finish the current useful turn normally; OpenCode will automatically continue with another goal turn.",
        "Use blocked only after the same blocking condition has prevented meaningful progress for at least three consecutive goal turns.",
        "A paused goal stops future automatic turns after the current provider turn. Do not change goal state unless the tool rules allow it.",
        "</active-goal>",
      ].join("\n")
    })

    return Service.of({
      get,
      set,
      edit,
      pause,
      resume,
      block,
      requestReview,
      beginReview,
      recoverReview,
      finishReview,
      clear,
      recordTurn,
      context,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Storage.node] })
