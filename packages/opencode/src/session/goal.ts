export * as SessionGoal from "./goal"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Storage } from "@/storage/storage"
import { SessionGoalEvent } from "@opencode-ai/schema/session-goal-event"
import { SessionID } from "./schema"

export const Event = SessionGoalEvent

export const Status = Schema.Literals(["active", "paused", "complete", "blocked"])
export type Status = Schema.Schema.Type<typeof Status>

export const ReviewStatus = Schema.Literals(["pending", "running", "accepted", "rejected", "error"])
export type ReviewStatus = Schema.Schema.Type<typeof ReviewStatus>

export const RequirementStatus = Schema.Literals(["unverified", "met", "unmet"])
export type RequirementStatus = Schema.Schema.Type<typeof RequirementStatus>

// One decomposed requirement of the objective. Written once by the first
// reviewer through goal_checklist, then carried across attempts so a later
// reviewer inherits conclusions instead of re-deriving them from a transcript
// it no longer receives. Optional on Info: goals stored before this existed
// must still decode.
const Requirement = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  status: RequirementStatus,
  evidence: Schema.optional(Schema.String),
  // Review attempt that last set the status; 0 while unverified.
  attempt: NonNegativeInt,
})
export type Requirement = Schema.Schema.Type<typeof Requirement>

// Measured, not assumed: what one review attempt actually cost. Recorded at
// finishReview so the retrieval design can be judged against numbers.
const AttemptStat = Schema.Struct({
  attempt: NonNegativeInt,
  inputTokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  retrievalCalls: NonNegativeInt,
  durationMs: NonNegativeInt,
})
export type AttemptStat = Schema.Schema.Type<typeof AttemptStat>

const Review = Schema.Struct({
  status: ReviewStatus,
  attempt: NonNegativeInt,
  requestedAt: NonNegativeInt,
  updatedAt: NonNegativeInt,
  evidence: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  reviewerSessionID: Schema.optional(SessionID),
  // Consecutive reviews that ended in error (timeout, no verdict, provider
  // failure). Drives continuation backoff: repeated review errors mean
  // something is systematically wrong, and re-reviewing instantly just spins
  // the loop. Reset by any review that produces a real verdict.
  errorStreak: Schema.optional(NonNegativeInt),
  // Structured verdict submitted by the reviewer through the goal_verdict
  // tool. Unforgeable by construction: the tool is only exposed to the
  // goal-reviewer agent, so the worker can never call it. When present it is
  // preferred over the text nonce fallback.
  verdict: Schema.optional(
    Schema.Struct({
      met: Schema.Boolean,
      summary: Schema.String,
      unmet: Schema.optional(
        Schema.mutable(
          Schema.Array(
            Schema.Struct({
              requirement: Schema.String,
              evidence: Schema.String,
            }),
          ),
        ),
      ),
      at: NonNegativeInt,
    }),
  ),
  // Rolling window of recent non-accepted attempts. The worker sees these in
  // its continuation message so a rejection for reason B does not erase the
  // memory of a rejection for reason A — the pattern that made workers cycle
  // between two failure modes.
  history: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          attempt: NonNegativeInt,
          reason: Schema.String,
          at: NonNegativeInt,
        }),
      ),
    ),
  ),
  // Per-attempt cost measurement. Optional so pre-tranche rows still decode.
  attemptStats: Schema.optional(Schema.mutable(Schema.Array(AttemptStat))),
})

export const Info = Schema.Struct({
  sessionID: SessionID,
  objective: Schema.String,
  status: Status,
  tokenBudget: Schema.optional(NonNegativeInt),
  tokensUsed: NonNegativeInt,
  turns: NonNegativeInt,
  // Consecutive automatic continuations caused by a worker turn ending
  // without a goal-tool claim. Optional so older persisted rows still decode.
  reminderStreak: Schema.optional(NonNegativeInt),
  blocker: Schema.optional(
    Schema.Struct({
      reason: Schema.String,
      count: NonNegativeInt,
      turn: NonNegativeInt,
    }),
  ),
  // Set when a goal turn ended without the model completing it — a provider
  // error, an exhausted retry, an abort. Such a turn made no completion claim,
  // so it is never handed to the reviewer; the worker is told to continue
  // instead. Cleared by the next turn that ends normally.
  interrupted: Schema.optional(
    Schema.Struct({
      reason: Schema.String,
      at: NonNegativeInt,
      count: NonNegativeInt,
    }),
  ),
  pauseReason: Schema.optional(Schema.Literals(["user", "budget", "interrupted"])),
  // Write-once decomposition of the objective, produced by the first reviewer.
  // Survives review attempts; cleared only when the objective itself changes.
  requirements: Schema.optional(Schema.mutable(Schema.Array(Requirement))),
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
  // Present when the turn ended abnormally; carries the operator-facing reason.
  interrupted: Schema.optional(Schema.String),
  // True when the turn actually returned control (a user-visible turn boundary).
  // Steps that continue into tool execution accumulate tokens but are not
  // goal turns: "three consecutive goal turns" must not be reachable inside a
  // single worker turn.
  completed: Schema.optional(Schema.Boolean),
})
export type RecordTurnInput = Schema.Schema.Type<typeof RecordTurnInput>

export const ReviewRequestInput = Schema.Struct({
  sessionID: SessionID,
  evidence: Schema.optional(Schema.String),
})
export type ReviewRequestInput = Schema.Schema.Type<typeof ReviewRequestInput>

export const RecordRequirementsInput = Schema.Struct({
  sessionID: SessionID,
  reviewerSessionID: SessionID,
  requirements: Schema.mutable(Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String }))),
  // A later reviewer may replace a checklist that clearly misinterprets the
  // objective. The tool layer demands a stated reason before setting this.
  revise: Schema.optional(Schema.Boolean),
})
export type RecordRequirementsInput = Schema.Schema.Type<typeof RecordRequirementsInput>

export const SubmitVerdictInput = Schema.Struct({
  sessionID: SessionID,
  reviewerSessionID: SessionID,
  met: Schema.Boolean,
  summary: Schema.String,
  unmet: Schema.optional(
    Schema.mutable(Schema.Array(Schema.Struct({ requirement: Schema.String, evidence: Schema.String }))),
  ),
  // Optional per-requirement roll-up against the persisted checklist. Ids that
  // do not exist are ignored here; the tool rejects them with a usable message.
  requirements: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          id: Schema.String,
          status: Schema.Literals(["met", "unmet"]),
          evidence: Schema.optional(Schema.String),
        }),
      ),
    ),
  ),
})
export type SubmitVerdictInput = Schema.Schema.Type<typeof SubmitVerdictInput>

export const ReviewFinishInput = Schema.Struct({
  sessionID: SessionID,
  reviewerSessionID: SessionID,
  accepted: Schema.Boolean,
  reason: Schema.String,
  tokens: NonNegativeInt,
  error: Schema.optional(Schema.Boolean),
  // Measured cost of this attempt. Folded into review.attemptStats in the same
  // session-bound mutation that closes the review.
  stats: Schema.optional(
    Schema.Struct({
      inputTokens: NonNegativeInt,
      cacheReadTokens: NonNegativeInt,
      outputTokens: NonNegativeInt,
      retrievalCalls: NonNegativeInt,
      durationMs: NonNegativeInt,
    }),
  ),
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
  readonly suspendForInterrupt: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly resume: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly block: (sessionID: SessionID, reason: string) => Effect.Effect<Info | undefined>
  readonly requestReview: (input: ReviewRequestInput) => Effect.Effect<Info | undefined>
  readonly beginReview: (sessionID: SessionID, reviewerSessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly recoverReview: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly recordRequirements: (input: RecordRequirementsInput) => Effect.Effect<Info | undefined>
  readonly submitVerdict: (input: SubmitVerdictInput) => Effect.Effect<Info | undefined>
  readonly finishReview: (input: ReviewFinishInput) => Effect.Effect<Info | undefined>
  readonly clear: (sessionID: SessionID) => Effect.Effect<boolean>
  readonly recordReminder: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly clearReminderStreak: (sessionID: SessionID) => Effect.Effect<Info | undefined>
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

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const events = yield* EventV2Bridge.Service
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
        // The checklist decomposes the OBJECTIVE. A new objective invalidates
        // it, and a stale checklist would silently constrain the next review to
        // requirements that no longer exist.
        draft.requirements = undefined
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

    const suspendForInterrupt = Effect.fn("SessionGoal.suspendForInterrupt")(function* (sessionID: SessionID) {
      return yield* update(sessionID, (draft, now) => {
        if (draft.status !== "active") return
        // An aborted run must not keep the elapsed clock ticking on a dead
        // session — but esc must NOT cancel or pause the goal either: it stays
        // active with a frozen clock, and the next message (or the TUI's own
        // continuation, which suppresses only the abort it issued) resumes it.
        stopClock(draft, now)
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
      const transition = { blocked: false }
      const result = yield* update(sessionID, (draft, now) => {
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
        transition.blocked = true
      })
      if (transition.blocked) yield* events.publish(Event.Blocked, { sessionID, reason: text })
      return result
    })

    const requestReview = Effect.fn("SessionGoal.requestReview")(function* (input: ReviewRequestInput) {
      return yield* update(input.sessionID, (draft, now) => {
        if (draft.status !== "active") return
        draft.reminderStreak = 0
        const evidence = input.evidence?.trim()
        draft.review = {
          status: "pending",
          attempt: (draft.review?.attempt ?? 0) + 1,
          requestedAt: now,
          updatedAt: now,
          ...(evidence ? { evidence } : {}),
          // Rejection history and the error streak survive across attempts;
          // everything else resets.
          ...(draft.review?.history?.length ? { history: draft.review.history } : {}),
          ...(draft.review?.errorStreak ? { errorStreak: draft.review.errorStreak } : {}),
          // Cost measurement is per goal, not per attempt: keeping only the
          // latest attempt's numbers would make the series unreadable exactly
          // when it matters (did retrieval get cheaper across attempts?).
          ...(draft.review?.attemptStats?.length ? { attemptStats: draft.review.attemptStats } : {}),
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
        draft.review.verdict = undefined
      })
    })

    const recoverReview = Effect.fn("SessionGoal.recoverReview")(function* (sessionID: SessionID) {
      return yield* update(sessionID, (draft, now) => {
        if (draft.review?.status !== "running") return
        draft.review.status = "pending"
        draft.review.updatedAt = now
        draft.review.reason = "The previous independent review was interrupted and has been queued again."
        draft.review.reviewerSessionID = undefined
        // A verdict submitted by the interrupted reviewer must not leak into
        // the next attempt as if the replacement reviewer had produced it.
        draft.review.verdict = undefined
      })
    })

    const recordRequirements = Effect.fn("SessionGoal.recordRequirements")(function* (input: RecordRequirementsInput) {
      return yield* update(input.sessionID, (draft, now) => {
        // Same gate as submitVerdict: only the reviewer session named by the
        // running review may write. Once written, replacement requires the
        // explicit revise flag (the tool demands a stated misreading first).
        if (draft.review?.status !== "running") return
        if (draft.review.reviewerSessionID !== input.reviewerSessionID) return
        if (draft.requirements?.length && !input.revise) return
        if (!input.requirements.length) return
        draft.requirements = input.requirements.map((item) => ({
          id: item.id,
          text: item.text,
          status: "unverified" as const,
          attempt: 0,
        }))
        draft.review.updatedAt = now
      })
    })

    const submitVerdict = Effect.fn("SessionGoal.submitVerdict")(function* (input: SubmitVerdictInput) {
      return yield* update(input.sessionID, (draft, now) => {
        // Only the reviewer session named by the running review may submit;
        // anything else is a stale or forged caller and is ignored.
        if (draft.review?.status !== "running") return
        if (draft.review.reviewerSessionID !== input.reviewerSessionID) return
        // First write wins: the tool contract is "call exactly once", and a
        // later call must not overwrite the verdict the review will act on.
        if (draft.review.verdict) return
        draft.review.verdict = {
          met: input.met,
          summary: input.summary,
          ...(input.unmet?.length ? { unmet: input.unmet } : {}),
          at: now,
        }
        // Fold per-requirement conclusions into durable state so the NEXT
        // reviewer inherits them. Unknown ids are dropped rather than invented.
        if (input.requirements?.length && draft.requirements?.length) {
          const attempt = draft.review.attempt
          const byID = new Map(input.requirements.map((item) => [item.id, item]))
          draft.requirements = draft.requirements.map((item) => {
            const next = byID.get(item.id)
            if (!next) return item
            const evidence = next.evidence?.trim()
            return {
              ...item,
              status: next.status,
              ...(evidence ? { evidence } : {}),
              attempt,
            }
          })
        }
        draft.review.updatedAt = now
      })
    })

    const finishReview = Effect.fn("SessionGoal.finishReview")(function* (input: ReviewFinishInput) {
      const transition = { completed: false }
      const result = yield* update(input.sessionID, (draft, now) => {
        if (draft.review?.status !== "running") return
        if (draft.review.reviewerSessionID !== input.reviewerSessionID) return
        draft.reminderStreak = 0
        draft.tokensUsed += input.tokens
        draft.review.status = input.error ? "error" : input.accepted ? "accepted" : "rejected"
        draft.review.errorStreak = input.error ? (draft.review.errorStreak ?? 0) + 1 : 0
        draft.review.updatedAt = now
        draft.review.reason =
          input.reason.trim() || (input.accepted ? "Goal requirements verified." : "Goal not verified.")
        if (input.stats) {
          draft.review.attemptStats = [
            ...(draft.review.attemptStats ?? []).filter((entry) => entry.attempt !== draft.review!.attempt),
            { attempt: draft.review.attempt, ...input.stats },
          ].slice(-20)
        }
        // Only substantive rejections enter the history the worker sees;
        // timeouts and provider failures are infrastructure noise tracked by
        // errorStreak, not reviewer feedback to act on.
        if (!input.accepted && !input.error) {
          draft.review.history = [
            ...(draft.review.history ?? []),
            { attempt: draft.review.attempt, reason: draft.review.reason, at: now },
          ].slice(-3)
        }
        if (!input.accepted) return
        if (draft.status === "complete" || draft.status === "blocked") return
        stopClock(draft, now)
        draft.status = "complete"
        draft.blocker = undefined
        draft.pauseReason = undefined
        draft.time.completed = now
        transition.completed = true
      })
      if (transition.completed) yield* events.publish(Event.Completed, { sessionID: input.sessionID })
      return result
    })

    const clear = Effect.fn("SessionGoal.clear")(function* (sessionID: SessionID) {
      const current = yield* get(sessionID)
      if (!current) return false
      yield* storage.remove(key(sessionID)).pipe(Effect.orDie)
      return true
    })

    const recordReminder = Effect.fn("SessionGoal.recordReminder")(function* (sessionID: SessionID) {
      return yield* update(sessionID, (draft) => {
        if (draft.status !== "active") return
        draft.reminderStreak = (draft.reminderStreak ?? 0) + 1
      })
    })

    const clearReminderStreak = Effect.fn("SessionGoal.clearReminderStreak")(function* (sessionID: SessionID) {
      return yield* update(sessionID, (draft) => {
        if (draft.status !== "active") return
        if (!draft.reminderStreak) return
        draft.reminderStreak = 0
      })
    })

    const recordTurn = Effect.fn("SessionGoal.recordTurn")(function* (input: RecordTurnInput) {
      const transition = { paused: false, tokenBudget: 0, tokensUsed: 0 }
      const result = yield* update(input.sessionID, (draft, now) => {
        if (input.completed !== false) draft.turns += 1
        draft.tokensUsed += input.tokens
        if (input.interrupted) {
          draft.interrupted = {
            reason: input.interrupted,
            at: now,
            count: (draft.interrupted?.count ?? 0) + 1,
          }
        } else if (input.completed !== false) {
          // Only a turn that returned control cleanly ends the outage; a
          // successful mid-turn tool step before the provider dies again must
          // not reset the backoff streak.
          draft.interrupted = undefined
        }
        if (draft.blocker && draft.blocker.turn < draft.turns) {
          draft.blocker = undefined
        }
        if (draft.status === "active" && draft.tokenBudget !== undefined && draft.tokensUsed >= draft.tokenBudget) {
          stopClock(draft, now)
          draft.status = "paused"
          draft.pauseReason = "budget"
          transition.paused = true
          transition.tokenBudget = draft.tokenBudget
          transition.tokensUsed = draft.tokensUsed
        }
      })
      if (transition.paused)
        yield* events.publish(Event.Paused, {
          sessionID: input.sessionID,
          reason: "budget",
          tokenBudget: transition.tokenBudget,
          tokensUsed: transition.tokensUsed,
        })
      return result
    })

    const context = Effect.fn("SessionGoal.context")(function* (sessionID: SessionID) {
      const info = yield* get(sessionID)
      if (info?.status !== "active") return
      return [
        "<active-goal>",
        `Status: ${info.status}`,
        `Objective: ${info.objective}`,
        "",
        // Review state stays in the system block on purpose. It changes only
        // at a review boundary, not on every request, so it costs a cache miss
        // per review rather than per turn — and it MUST be here: when a worker
        // requests completion via the goal tool the loop continues inside the
        // same turn, so no continuation message is generated and the
        // continuation is not a channel the reviewer's feedback can rely on.
        // Elapsed time, turn and token counts move out because they change on
        // literally every request and would invalidate the cached prefix
        // continuously.
        ...(info.review?.status === "rejected" || info.review?.status === "error"
          ? [
              `Independent review attempt ${info.review.attempt} did not accept completion: ${info.review.reason ?? "No valid reviewer verdict was produced."}`,
            ]
          : info.review?.status === "pending" || info.review?.status === "running"
            ? [`Independent review attempt ${info.review.attempt} is ${info.review.status}.`]
            : []),
        "Current elapsed time, turn and token accounting, blocker state, and interruption details arrive in each goal continuation turn message.",
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
      suspendForInterrupt,
      resume,
      block,
      requestReview,
      beginReview,
      recoverReview,
      recordRequirements,
      submitVerdict,
      finishReview,
      clear,
      recordReminder,
      clearReminderStreak,
      recordTurn,
      context,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Storage.node, EventV2Bridge.node] })
