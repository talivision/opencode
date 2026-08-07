import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Project } from "@opencode-ai/schema/project"
import { Deferred, Effect, Layer, Context, Schema } from "effect"
import os from "os"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { Storage } from "@/storage/storage"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"

export const Event = PermissionV1.Event

export interface RevokeInput {
  permission?: string
  pattern?: string
}

export interface AutoStatus {
  /** Effective mode for this session, including inheritance from an ancestor. */
  enabled: boolean
  /** True when auto mode was turned on for this exact session, not inherited. */
  explicit: boolean
  /** The ancestor the mode was inherited from, when inherited. */
  source?: SessionID
}

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
  /** Runtime grants currently in effect for this instance (persisted + this-run only). */
  readonly grants: () => Effect.Effect<ReadonlyArray<PermissionV1.Rule>>
  /**
   * Drop runtime grants matching `input` (exact string match on permission and/or
   * pattern; omit both to drop everything) from memory and from the project store.
   * Returns how many grants were removed.
   */
  readonly revoke: (input?: RevokeInput) => Effect.Effect<number>
  /**
   * Turn auto mode on or off for one session. Every descendant session inherits
   * it, so a subagent (goal reviewer included) spawned from an auto session
   * never asks. Turning it on also releases anything already pending for that
   * session tree. Returns the effective status of the session afterwards.
   *
   * Fails when the session does not exist: this is reachable unauthenticated
   * over HTTP, and an id that names nothing would let a caller arm auto mode
   * for a session before it is created, where no UI can show it.
   */
  readonly setAuto: (input: {
    sessionID: SessionID
    enabled: boolean
  }) => Effect.Effect<AutoStatus, Storage.NotFoundError>
  /** Effective auto-mode status for a session, resolving the ancestor chain. */
  readonly getAuto: (sessionID: SessionID) => Effect.Effect<AutoStatus>
  /** Sessions auto mode was explicitly turned on for. */
  readonly autoSessions: () => Effect.Effect<ReadonlyArray<AutoSession>>
  /** Audit trail of everything auto mode approved without asking. */
  readonly autoLog: () => Effect.Effect<ReadonlyArray<AutoApproval>>
}

interface PendingEntry {
  info: PermissionV1.Request
  // Kept so the drain in `reply` can re-evaluate a pending request against its
  // own static ruleset, not just against the runtime grants.
  ruleset: PermissionV1.Ruleset
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
  projectID: string
  persist: boolean
  /** Sessions auto mode was turned on for explicitly, keyed by session id. */
  auto: Map<SessionID, number>
  /** Memoized ancestor-chain resolution; cleared whenever `auto` changes. */
  autoResolved: Map<SessionID, { enabled: boolean; source?: SessionID }>
  /**
   * Bumped every time `auto`/`autoResolved` change. `resolveAuto` suspends on
   * session lookups while it walks the ancestor chain, so it captures this
   * before the walk and refuses to write a memo entry computed from a snapshot
   * that has since been invalidated - otherwise a stale "enabled" could outlive
   * the very call that turned auto mode off.
   */
  autoGen: number
  audit: AuditEntry[]
  /** `audit` keyed by session+permission+pattern, for O(1) recurrence lookup. */
  auditIndex: Map<string, AuditEntry>
  auditDirty: boolean
  auditFlushedAt: number
}

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

/**
 * Resolve a permission against the static ruleset plus the runtime grants the
 * user produced by answering "always".
 *
 * Precedence is deliberately NOT "last rule wins" across the concatenation of
 * both lists. A runtime grant may only upgrade `ask` -> `allow`; an explicit
 * `deny` (or `allow`) in the ruleset always wins. This matters because the
 * patterns behind an "always" click are authored by the *tool*, not the user
 * (`task` sends `always: ["*"]`), so concatenating grants after the ruleset let
 * a single click unlock everything the config denied.
 */
export function evaluateGranted(
  permission: string,
  pattern: string,
  ruleset: PermissionV1.Ruleset,
  grants: PermissionV1.Ruleset,
): PermissionV1.Rule {
  const rule = evaluate(permission, pattern, ruleset)
  if (rule.action !== "ask") return rule
  const grant = evaluate(permission, pattern, grants)
  return grant.action === "allow" ? grant : rule
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

// Persisted grant. `pattern` is always the pattern the user was actually shown
// in the request (`Request.patterns`), never the tool-authored `always`
// wildcard, so a single click cannot write `*` to disk. `action` is implicitly
// "allow": deny is config-only and a stored grant can never produce one.
export const Grant = Schema.Struct({
  permission: Schema.String,
  pattern: Schema.String,
  time: Schema.Number,
})
export type Grant = Schema.Schema.Type<typeof Grant>

/** A session that is running in auto mode. Descendants inherit it. */
export const AutoSession = Schema.Struct({
  sessionID: SessionID,
  time: Schema.Number,
})
export type AutoSession = Schema.Schema.Type<typeof AutoSession>

/**
 * Audit trail entry: something auto mode approved without asking. This is NOT a
 * grant - it grants nothing and is never consulted by `evaluate`. It exists so
 * an unattended run can be reviewed afterwards.
 *
 * One entry per (session, permission, pattern). Recurrences bump `count` and
 * `last` instead of appending, so a loop cannot flood the file, and - unlike
 * plain dedup - the review still shows that the call happened 900 times.
 */
export const AutoApproval = Schema.Struct({
  sessionID: SessionID,
  permission: Schema.String,
  pattern: Schema.String,
  /** First time this was auto-approved. */
  time: Schema.Number,
  /** Most recent time. Optional so files written before it existed decode. */
  last: Schema.optional(Schema.Number),
  /** How many times in total. Optional for the same reason. */
  count: Schema.optional(Schema.Number),
})
export type AutoApproval = Schema.Schema.Type<typeof AutoApproval>

/** Working copy of an audit entry: recurrences update it in place. */
type AuditEntry = { -readonly [K in keyof AutoApproval]: AutoApproval[K] }

const AUDIT_LIMIT = 500
/**
 * A brand new audit entry is always written through immediately. A recurrence
 * only moves a counter, so it is written at most this often - otherwise every
 * auto-approved tool call in an unattended loop would rewrite the file.
 */
const AUDIT_FLUSH_MS = 2_000

const auditKey = (sessionID: string, permission: string, pattern: string) => `${sessionID} ${permission} ${pattern}`

const ProjectFile = Schema.Struct({
  projectID: Schema.String,
  worktree: Schema.optional(Schema.String),
  grants: Schema.mutable(Schema.Array(Grant)),
  // Optional so files written before these existed still decode.
  auto: Schema.optional(Schema.mutable(Schema.Array(AutoSession))),
  audit: Schema.optional(Schema.mutable(Schema.Array(AutoApproval))),
})
const decodeProjectFile = Schema.decodeUnknownEffect(ProjectFile)

/** Mutable view of the stored file, used while read-modify-writing it. */
interface ProjectFile {
  projectID: string
  worktree?: string
  grants: Grant[]
  auto: AutoSession[]
  audit: AuditEntry[]
}

/**
 * SECURITY / SCOPING DECISION.
 *
 * Grants are stored under the project id, never globally. A grant made while
 * working on project A must not silently apply in project B: the stored file is
 * only ever read back for the same project id, which is derived from the VCS
 * root (so sibling worktrees of one repository - the same trust domain - share
 * grants, and unrelated checkouts never do).
 *
 * The residual risk that remains, and why the two rules above exist: a stored
 * grant outlives the task it was granted for. Mitigations are (a) only the
 * concrete pattern the user saw is stored, so the blast radius equals the
 * request the user actually read, and (b) an explicit config `deny` outranks
 * every stored grant, so denies stay authoritative across restarts.
 *
 * Exception, and the reason `persistable` exists: `Project.resolve` has no
 * repository to derive an id from outside a VCS checkout, so it returns the
 * shared sentinel `global`. Every non-git directory on the machine resolves to
 * that one id, which would make one file the store for all of them - an
 * "always" granted in ~/scratch would be in force in ~/finance, which is
 * exactly the property the paragraph above promises. Rather than key those
 * directories separately (there is no stable key: the same path can be two
 * unrelated trust domains over time), nothing is persisted for them at all.
 * Grants there last for the run, as if `permission_persist` were off.
 */
function grantKey(projectID: string) {
  return ["permission", projectID]
}

/**
 * False for the `global` sentinel project - see the note above. Every non-git
 * directory shares that id, so it can never be a persistence boundary.
 */
function persistable(projectID: string) {
  return projectID !== Project.ID.global
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const storage = yield* Storage.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const flock = yield* EffectFlock.Service

    const read = (projectID: string): Effect.Effect<ProjectFile | undefined> =>
      storage.read<unknown>(grantKey(projectID)).pipe(
        Effect.flatMap((raw) => decodeProjectFile(raw)),
        Effect.map(
          (file): ProjectFile => ({
            projectID: file.projectID,
            worktree: file.worktree,
            grants: [...file.grants],
            auto: [...(file.auto ?? [])],
            audit: [...(file.audit ?? [])],
          }),
        ),
        Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
        Effect.tapCause((cause) => Effect.logError("failed to read persisted permission state", { projectID, cause })),
        Effect.catchCause(() => Effect.succeed(undefined)),
      )

    const write = (file: ProjectFile) =>
      storage.write(grantKey(file.projectID), file).pipe(Effect.catchCause(() => Effect.void))

    /**
     * `Storage.update`'s lock is per-path and in-process only. Two opencode
     * processes on sibling worktrees resolve to the same project id and so to
     * the same file, and would interleave their read-modify-writes with no
     * exclusion at all. This is the same advisory file lock the rest of the
     * codebase uses for cross-process state.
     *
     * It is best-effort: if the lock cannot be taken the write still happens,
     * because losing a grant to a racing process is a smaller failure than
     * refusing to record one at all. Lock loss is logged.
     */
    const guarded = <R>(projectID: string, body: Effect.Effect<void, never, R>): Effect.Effect<void, never, R> =>
      flock.withLock(body, "permission-" + projectID).pipe(
        Effect.catchTags({
          LockTimeoutError: (error) =>
            Effect.logWarning("permission store lock timed out; writing unlocked", {
              projectID,
              key: error.key,
            }).pipe(Effect.andThen(body)),
          LockCompromisedError: (error) =>
            Effect.logWarning("permission store lock compromised; writing unlocked", {
              projectID,
              detail: error.detail,
            }).pipe(Effect.andThen(body)),
        }),
      )

    /**
     * Read-modify-write the project file, or do nothing when persistence is off.
     * Goes through `Storage.update` so the read and the write happen under one
     * write lock: two sessions approving at the same moment cannot lose a grant.
     *
     * `fn` must express a *delta* against whatever is already on disk (append
     * this grant, drop this session id) and never assign a whole array from
     * in-memory state: another instance on the same project has its own state,
     * and a wholesale assignment silently deletes its rows.
     */
    const mutate = (current: State, fn: (file: ProjectFile) => boolean) =>
      Effect.gen(function* () {
        if (!current.persist) return
        const missing = yield* storage
          .update<ProjectFile>(grantKey(current.projectID), (draft) => {
            // A file written before `auto`/`audit` existed has neither.
            draft.grants ??= []
            draft.auto ??= []
            draft.audit ??= []
            fn(draft)
          })
          .pipe(
            Effect.as(false),
            // Only "the file is not there yet" may be answered by writing a new
            // one. A decode error or a disk error must not be, or a single
            // transient failure would replace every stored grant with nothing.
            Effect.catchTag("NotFoundError", () => Effect.succeed(true)),
            Effect.tapCause((cause) =>
              Effect.logError("failed to update permission store", { projectID: current.projectID, cause }),
            ),
            Effect.catchCause(() => Effect.succeed(false)),
          )
        if (!missing) return
        const fresh: ProjectFile = {
          projectID: current.projectID,
          worktree: (yield* InstanceState.context).worktree,
          grants: [],
          auto: [],
          audit: [],
        }
        if (!fn(fresh)) return
        yield* write(fresh)
      }).pipe((body) => guarded(current.projectID, body))

    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        const projectID = ctx.project.id
        const configured = yield* Effect.map(config.get(), (cfg) => cfg.permission_persist !== false)
        const persist = configured && persistable(projectID)
        if (configured && !persist)
          yield* Effect.logInfo("permission state is not persisted outside a repository", {
            projectID,
            worktree: ctx.worktree,
          })
        // Opting out disables both halves: nothing is written, and anything a
        // previous run wrote is ignored rather than silently still in force.
        const stored = persist ? yield* read(projectID) : undefined
        const audit = (stored?.audit ?? []).slice(-AUDIT_LIMIT)
        const state: State = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: (stored?.grants ?? []).map((grant) => ({
            permission: grant.permission,
            pattern: grant.pattern,
            action: "allow" as const,
          })),
          projectID,
          persist,
          // Restoring this is what preserves auto mode across resume/continue
          // and across a reconnect: the mode lives with the session, not with
          // the client that happened to set it.
          auto: new Map((stored?.auto ?? []).map((item) => [item.sessionID, item.time])),
          autoResolved: new Map(),
          autoGen: 0,
          audit,
          auditIndex: new Map(audit.map((item) => [auditKey(item.sessionID, item.permission, item.pattern), item])),
          auditDirty: false,
          auditFlushedAt: 0,
        }
        if (state.approved.length)
          yield* Effect.logInfo("loaded persisted permission grants", { projectID, count: state.approved.length })
        if (state.auto.size) yield* Effect.logInfo("restored auto-mode sessions", { projectID, count: state.auto.size })

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
            // Recurrence counters are throttled while running; a clean shutdown
            // must not lose the last window of them.
            if (state.auditDirty) yield* flushAudit(state, Date.now())
          }),
        )

        return state
      }),
    )

    const remember = Effect.fnUntraced(function* (current: State, request: PermissionV1.Request) {
      const now = Date.now()
      yield* mutate(current, (stored) => {
        let changed = false
        // Only the patterns the user was shown are durable. `request.always` is
        // tool-authored and stays in-memory for this run only.
        for (const pattern of request.patterns) {
          if (stored.grants.some((item) => item.permission === request.permission && item.pattern === pattern)) continue
          stored.grants.push({ permission: request.permission, pattern, time: now })
          changed = true
        }
        return changed
      })
      if (current.persist)
        yield* Effect.logInfo("persisted permission grant", {
          projectID: current.projectID,
          permission: request.permission,
          patterns: request.patterns,
        })
    })

    const lookup = (sessionID: SessionID) =>
      sessions.get(sessionID).pipe(
        Effect.map((info): Session.Info | undefined => info),
        Effect.catchCause(() => Effect.succeed(undefined)),
      )

    /** Invalidate every memoized answer. Must accompany any change to `auto`. */
    const invalidate = (current: State) => {
      current.autoGen++
      current.autoResolved.clear()
    }

    /**
     * Drop the auto row for a session that no longer exists, from memory and
     * from disk. Without this a deleted session's row lives forever: it keeps
     * conferring inherited auto mode on the descendants that outlived it (the
     * ancestor walk would find the row before it discovered the session was
     * gone), and the stored array only ever grows.
     */
    const forget = Effect.fnUntraced(function* (current: State, sessionID: SessionID) {
      if (!current.auto.delete(sessionID)) return false
      invalidate(current)
      yield* Effect.logInfo("dropped auto mode for a deleted session", {
        projectID: current.projectID,
        sessionID,
      })
      yield* mutate(current, (stored) => {
        const kept = stored.auto.filter((item) => item.sessionID !== sessionID)
        if (kept.length === stored.auto.length) return false
        stored.auto = kept
        return true
      })
      return true
    })

    /**
     * A memoized answer is only good while the session it came from still
     * exists. Deleting the session auto mode was turned on for revokes it for
     * everything below, the same way a deleted ancestor fails closed elsewhere.
     */
    const aliveSource = Effect.fnUntraced(function* (current: State, source: SessionID | undefined) {
      if (source === undefined) return true
      if (yield* lookup(source)) return true
      // Always invalidates on the way out, even when there was no row left to
      // drop, so a caller can safely retry instead of reading the same dead
      // answer back out of the memo forever.
      if (!(yield* forget(current, source))) invalidate(current)
      return false
    })

    const status = (sessionID: SessionID, value: { enabled: boolean; source?: SessionID }): AutoStatus => ({
      enabled: value.enabled,
      // Derived rather than read off `auto` separately: the two must never
      // disagree, and a cached answer has no separate `explicit` to return.
      explicit: value.enabled && value.source === sessionID,
      source: value.source,
    })

    /**
     * Is this session running in auto mode? A session inherits the mode from any
     * ancestor, which is what makes subagents - goal reviewers above all - stop
     * re-asking when their parent is auto. Sessions that do not exist, and
     * ancestors that have been deleted, terminate the walk without enabling it.
     */
    const resolveAuto = Effect.fnUntraced(function* (current: State, sessionID: SessionID) {
      // Loops only when the walk discovered that the session behind a memoized
      // answer had been deleted. Each such pass drops the offending row and
      // clears the memo, so it cannot spin.
      while (true) {
        const cached = current.autoResolved.get(sessionID)
        if (cached !== undefined) {
          if (yield* aliveSource(current, cached.source)) return status(sessionID, cached)
          continue
        }
        // Captured before the first suspension point below. Anything that
        // changes `auto` while this walk is parked bumps it, and the result is
        // then used once but not memoized - a memo written after its own
        // invalidation would keep answering with the pre-change value
        // indefinitely.
        const generation = current.autoGen
        const chain: SessionID[] = []
        const seen = new Set<SessionID>()
        let cursor: SessionID | undefined = sessionID
        let enabled = false
        let source: SessionID | undefined
        let stale = false
        while (cursor && !seen.has(cursor)) {
          seen.add(cursor)
          chain.push(cursor)
          if (chain.length > 1) {
            const resolved = current.autoResolved.get(cursor)
            if (resolved !== undefined) {
              // An ancestor's memo is only usable while the session it credits
              // still exists, or a deleted grantor would keep granting through
              // every descendant that had already been resolved once.
              if (!(yield* aliveSource(current, resolved.source))) {
                stale = true
                break
              }
              enabled = resolved.enabled
              source = resolved.source
              break
            }
          }
          const info: Session.Info | undefined = yield* lookup(cursor)
          if (!info) {
            // Fail closed. A row for a session that is gone grants nothing.
            yield* forget(current, cursor)
            break
          }
          if (current.auto.has(cursor)) {
            enabled = true
            source = cursor
            break
          }
          cursor = info.parentID
        }
        if (stale) continue
        if (generation === current.autoGen) for (const id of chain) current.autoResolved.set(id, { enabled, source })
        return status(sessionID, { enabled, source })
      }
    })

    /** Drop every auto row whose session no longer exists. */
    const pruneAuto = Effect.fnUntraced(function* (current: State) {
      for (const sessionID of Array.from(current.auto.keys())) {
        if (yield* lookup(sessionID)) continue
        yield* forget(current, sessionID)
      }
    })

    /** The session and every ancestor above it, nearest first. */
    const lineage = Effect.fnUntraced(function* (sessionID: SessionID) {
      const chain: SessionID[] = [sessionID]
      const seen = new Set<SessionID>([sessionID])
      let cursor: SessionID = sessionID
      while (true) {
        const info: Session.Info | undefined = yield* sessions
          .get(cursor)
          .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        const parent = info?.parentID
        if (!parent || seen.has(parent)) return chain
        chain.push(parent)
        seen.add(parent)
        cursor = parent
      }
    })

    /**
     * Write the in-memory audit trail through, merging into whatever is on
     * disk instead of replacing it: another instance on the same project keeps
     * its own trail, and for a security log silent deletion is the worst
     * possible failure mode.
     *
     * `count` merges by max, not by sum: the same entry is flushed repeatedly
     * from this process and summing would multiply it. Two processes counting
     * the same pattern concurrently therefore under-report the total, which is
     * the safe direction - the entry itself is never lost.
     */
    const flushAudit = Effect.fnUntraced(function* (current: State, now: number) {
      current.auditDirty = false
      current.auditFlushedAt = now
      yield* mutate(current, (stored) => {
        const index = new Map(
          stored.audit.map((item) => [auditKey(item.sessionID, item.permission, item.pattern), item] as const),
        )
        for (const item of current.audit) {
          const key = auditKey(item.sessionID, item.permission, item.pattern)
          const existing = index.get(key)
          if (!existing) {
            const copy = { ...item }
            stored.audit.push(copy)
            index.set(key, copy)
            continue
          }
          existing.time = Math.min(existing.time, item.time)
          existing.last = Math.max(existing.last ?? existing.time, item.last ?? item.time)
          existing.count = Math.max(existing.count ?? 1, item.count ?? 1)
        }
        if (stored.audit.length > AUDIT_LIMIT) stored.audit.splice(0, stored.audit.length - AUDIT_LIMIT)
        return true
      })
    })

    /**
     * Record an auto-approval. Deliberately separate from `remember`: auto mode
     * must never widen the durable allow list, so this only ever appends to the
     * audit trail. A repeat of something already recorded bumps its counter
     * rather than appending, so a loop cannot flood the file - but the repeat
     * is still visible in the review, which a plain dedup threw away.
     */
    const recordAuto = Effect.fnUntraced(function* (
      current: State,
      sessionID: SessionID,
      permission: string,
      patterns: readonly string[],
    ) {
      const now = Date.now()
      let added = false
      for (const pattern of patterns) {
        const key = auditKey(sessionID, permission, pattern)
        const existing = current.auditIndex.get(key)
        if (existing) {
          existing.last = now
          existing.count = (existing.count ?? 1) + 1
          continue
        }
        const entry: AuditEntry = { sessionID, permission, pattern, time: now, last: now, count: 1 }
        current.audit.push(entry)
        current.auditIndex.set(key, entry)
        added = true
      }
      yield* Effect.logInfo("auto-approved permission", { sessionID, permission, patterns })
      if (current.audit.length > AUDIT_LIMIT) {
        const dropped = current.audit.splice(0, current.audit.length - AUDIT_LIMIT)
        for (const item of dropped) current.auditIndex.delete(auditKey(item.sessionID, item.permission, item.pattern))
        // The trail is capped, so a long unattended run does lose its oldest
        // entries. Say so rather than letting the review silently be partial.
        yield* Effect.logWarning("auto-approval audit trail truncated", {
          projectID: current.projectID,
          dropped: dropped.length,
          limit: AUDIT_LIMIT,
        })
      }
      current.auditDirty = true
      if (!added && now - current.auditFlushedAt < AUDIT_FLUSH_MS) return
      yield* flushAudit(current, now)
    })

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const current = yield* InstanceState.get(state)
      const { approved, pending } = current
      const { ruleset, ...request } = input
      let needsAsk = false
      const auto = yield* resolveAuto(current, request.sessionID)
      const autoApproved: string[] = []

      for (const pattern of request.patterns) {
        const rule = evaluateGranted(request.permission, pattern, ruleset, approved)
        yield* Effect.logInfo("evaluated", { permission: request.permission, pattern, action: rule })
        // Checked before auto mode on purpose: auto turns "ask" into "allow" and
        // never turns an explicit "deny" into "allow".
        if (rule.action === "deny") {
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") continue
        if (auto.enabled) {
          autoApproved.push(pattern)
          continue
        }
        needsAsk = true
      }

      // Resolved server-side, so it works with no client attached - a dropped
      // connection can no longer strand a request that auto mode would approve.
      if (autoApproved.length) yield* recordAuto(current, request.sessionID, request.permission, autoApproved)
      if (!needsAsk) return

      const id = request.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        always: request.always,
        tool: request.tool,
      }
      yield* Effect.logInfo("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      pending.set(id, { info, ruleset, deferred })
      yield* events.publish(Event.Asked, info)
      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const current = yield* InstanceState.get(state)
      const { approved, pending } = current
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      pending.delete(input.requestID)
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once") return

      // In-memory grants keep the tool-authored `always` semantics for this run.
      for (const pattern of existing.info.always) {
        if (approved.some((rule) => rule.permission === existing.info.permission && rule.pattern === pattern)) continue
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }
      // Durable grants are narrower: only what the user was shown.
      for (const pattern of existing.info.patterns) {
        if (approved.some((rule) => rule.permission === existing.info.permission && rule.pattern === pattern)) continue
        approved.push({ permission: existing.info.permission, pattern, action: "allow" })
      }
      yield* remember(current, existing.info)

      // Drain the session that answered plus anything it spawned. A subagent
      // already blocked on the same thing the parent just approved should not
      // have to be approved a second time. Unrelated sessions keep asking.
      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) {
          const chain = yield* lineage(item.info.sessionID)
          if (!chain.includes(existing.info.sessionID)) continue
        }
        const ok = item.info.patterns.every(
          (pattern) => evaluateGranted(item.info.permission, pattern, item.ruleset, approved).action === "allow",
        )
        if (!ok) continue
        pending.delete(id)
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    const grants = Effect.fn("Permission.grants")(function* () {
      return (yield* InstanceState.get(state)).approved.slice()
    })

    const revoke = Effect.fn("Permission.revoke")(function* (input?: RevokeInput) {
      const current = yield* InstanceState.get(state)
      const matches = (rule: { permission: string; pattern: string }) =>
        (input?.permission === undefined || rule.permission === input.permission) &&
        (input?.pattern === undefined || rule.pattern === input.pattern)

      const kept = current.approved.filter((rule) => !matches(rule))
      const removed = current.approved.length - kept.length
      current.approved.splice(0, current.approved.length, ...kept)

      // Filtering inside the callback keeps the read and the write under one
      // lock. Read-then-write took the lock twice and dropped anything a
      // concurrent `remember` wrote in between.
      yield* mutate(current, (stored) => {
        const keptGrants = stored.grants.filter((grant) => !matches(grant))
        if (keptGrants.length === stored.grants.length) return false
        stored.grants = keptGrants
        return true
      })
      return removed
    })

    const getAuto = Effect.fn("Permission.getAuto")(function* (sessionID: SessionID) {
      const current = yield* InstanceState.get(state)
      return yield* resolveAuto(current, sessionID)
    })

    const setAuto = Effect.fn("Permission.setAuto")(function* (input: { sessionID: SessionID; enabled: boolean }) {
      const current = yield* InstanceState.get(state)
      // Reachable unauthenticated over HTTP. Requiring the session to exist is
      // not authorization, but it does stop the endpoint from writing rows for
      // ids that name nothing, which no client could ever show or undo.
      yield* sessions.get(input.sessionID)
      const time = Date.now()
      if (input.enabled) current.auto.set(input.sessionID, time)
      else current.auto.delete(input.sessionID)
      // Inheritance is resolved lazily and memoized, so any change invalidates
      // every descendant's answer.
      invalidate(current)
      // A delta, not an assignment of the whole map: see `mutate`.
      yield* mutate(current, (stored) => {
        const kept = stored.auto.filter((item) => item.sessionID !== input.sessionID)
        if (input.enabled) kept.push({ sessionID: input.sessionID, time })
        if (kept.length === stored.auto.length && !input.enabled) return false
        stored.auto = kept
        return true
      })
      // Bounded housekeeping on a rare call: rows whose session was deleted
      // would otherwise accumulate in the file forever.
      yield* pruneAuto(current)
      yield* Effect.logInfo("auto mode changed", { sessionID: input.sessionID, enabled: input.enabled })

      // Auto mode suppresses every future prompt for this session and its
      // descendants, so the change itself is published - a silent switch is
      // indistinguishable from "nothing needed approval".
      const changed = yield* resolveAuto(current, input.sessionID)
      yield* events.publish(Event.AutoChanged, {
        sessionID: input.sessionID,
        enabled: changed.enabled,
        explicit: changed.explicit,
        source: changed.source,
      })

      // Turning it off leaves nothing behind: no grant was ever written for an
      // auto-approval, so the durable allow list is untouched here by design.
      if (!input.enabled) return changed

      // Release anything already waiting in this session tree.
      for (const [id, item] of Array.from(current.pending.entries())) {
        const status = yield* resolveAuto(current, item.info.sessionID)
        if (!status.enabled) continue
        const denied = item.info.patterns.some(
          (pattern) => evaluateGranted(item.info.permission, pattern, item.ruleset, current.approved).action === "deny",
        )
        if (denied) continue
        current.pending.delete(id)
        yield* recordAuto(current, item.info.sessionID, item.info.permission, item.info.patterns)
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "once",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
      return yield* resolveAuto(current, input.sessionID)
    })

    const autoSessions = Effect.fn("Permission.autoSessions")(function* () {
      const current = yield* InstanceState.get(state)
      return Array.from(current.auto, ([sessionID, time]) => ({ sessionID, time }))
    })

    const autoLog = Effect.fn("Permission.autoLog")(function* () {
      return (yield* InstanceState.get(state)).audit.slice()
    })

    return Service.of({ ask, reply, list, grants, revoke, setAuto, getAuto, autoSessions, autoLog })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: PermissionV1.Ruleset): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [EventV2Bridge.node, Storage.node, Config.node, Session.node, EffectFlock.node],
})

export * as Permission from "."
