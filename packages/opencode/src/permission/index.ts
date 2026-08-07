import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
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
   */
  readonly setAuto: (input: { sessionID: SessionID; enabled: boolean }) => Effect.Effect<AutoStatus>
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
  audit: AutoApproval[]
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
 */
export const AutoApproval = Schema.Struct({
  sessionID: SessionID,
  permission: Schema.String,
  pattern: Schema.String,
  time: Schema.Number,
})
export type AutoApproval = Schema.Schema.Type<typeof AutoApproval>

const AUDIT_LIMIT = 500

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
  audit: AutoApproval[]
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
 */
function grantKey(projectID: string) {
  return ["permission", projectID]
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const storage = yield* Storage.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service

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
        Effect.catchCause(() => Effect.succeed(undefined)),
      )

    const write = (file: ProjectFile) =>
      storage.write(grantKey(file.projectID), file).pipe(Effect.catchCause(() => Effect.void))

    /**
     * Read-modify-write the project file, or do nothing when persistence is off.
     * Goes through `Storage.update` so the read and the write happen under one
     * write lock: two sessions approving at the same moment cannot lose a grant.
     */
    const mutate = (current: State, fn: (file: ProjectFile) => boolean) =>
      Effect.gen(function* () {
        if (!current.persist) return
        const updated = yield* storage
          .update<ProjectFile>(grantKey(current.projectID), (draft) => {
            // A file written before `auto`/`audit` existed has neither.
            draft.grants ??= []
            draft.auto ??= []
            draft.audit ??= []
            fn(draft)
          })
          .pipe(
            Effect.as(true),
            Effect.catchCause(() => Effect.succeed(false)),
          )
        if (updated) return
        const fresh: ProjectFile = {
          projectID: current.projectID,
          worktree: (yield* InstanceState.context).worktree,
          grants: [],
          auto: [],
          audit: [],
        }
        if (!fn(fresh)) return
        yield* write(fresh)
      })

    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        const persist = yield* Effect.map(config.get(), (cfg) => cfg.permission_persist !== false)
        const projectID = ctx.project.id
        // Opting out disables both halves: nothing is written, and anything a
        // previous run wrote is ignored rather than silently still in force.
        const stored = persist ? yield* read(projectID) : undefined
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
          audit: (stored?.audit ?? []).slice(-AUDIT_LIMIT),
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

    /**
     * Is this session running in auto mode? A session inherits the mode from any
     * ancestor, which is what makes subagents - goal reviewers above all - stop
     * re-asking when their parent is auto. Unknown/orphan sessions simply
     * terminate the walk.
     */
    const resolveAuto = Effect.fnUntraced(function* (current: State, sessionID: SessionID) {
      const explicit = current.auto.has(sessionID)
      const cached = current.autoResolved.get(sessionID)
      if (cached !== undefined) return { ...cached, explicit } satisfies AutoStatus
      const chain: SessionID[] = []
      const seen = new Set<SessionID>()
      let cursor: SessionID | undefined = sessionID
      let enabled = false
      let source: SessionID | undefined
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor)
        chain.push(cursor)
        if (current.auto.has(cursor)) {
          enabled = true
          source = cursor
          break
        }
        const resolved = current.autoResolved.get(cursor)
        if (resolved !== undefined) {
          enabled = resolved.enabled
          source = resolved.source
          break
        }
        const info: Session.Info | undefined = yield* sessions
          .get(cursor)
          .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        cursor = info?.parentID
      }
      for (const id of chain) current.autoResolved.set(id, { enabled, source })
      return { enabled, explicit, source } satisfies AutoStatus
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
     * Record an auto-approval. Deliberately separate from `remember`: auto mode
     * must never widen the durable allow list, so this only ever appends to the
     * audit trail. Deduped per session so a loop of identical calls does not
     * rewrite the file on every tool call.
     */
    const recordAuto = Effect.fnUntraced(function* (
      current: State,
      sessionID: SessionID,
      permission: string,
      patterns: readonly string[],
    ) {
      const now = Date.now()
      const fresh = patterns.filter(
        (pattern) =>
          !current.audit.some(
            (item) => item.sessionID === sessionID && item.permission === permission && item.pattern === pattern,
          ),
      )
      yield* Effect.logInfo("auto-approved permission", { sessionID, permission, patterns })
      if (!fresh.length) return
      for (const pattern of fresh) {
        current.audit.push({ sessionID, permission, pattern, time: now })
      }
      if (current.audit.length > AUDIT_LIMIT) current.audit.splice(0, current.audit.length - AUDIT_LIMIT)
      yield* mutate(current, (stored) => {
        stored.audit = current.audit.slice()
        return true
      })
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

      const stored = yield* read(current.projectID)
      if (stored) {
        const keptGrants = stored.grants.filter((grant) => !matches(grant))
        if (keptGrants.length !== stored.grants.length) yield* write({ ...stored, grants: keptGrants })
      }
      return removed
    })

    const getAuto = Effect.fn("Permission.getAuto")(function* (sessionID: SessionID) {
      const current = yield* InstanceState.get(state)
      return yield* resolveAuto(current, sessionID)
    })

    const setAuto = Effect.fn("Permission.setAuto")(function* (input: { sessionID: SessionID; enabled: boolean }) {
      const current = yield* InstanceState.get(state)
      if (input.enabled) current.auto.set(input.sessionID, Date.now())
      else current.auto.delete(input.sessionID)
      // Inheritance is resolved lazily and memoized, so any change invalidates
      // every descendant's answer.
      current.autoResolved.clear()
      yield* mutate(current, (stored) => {
        stored.auto = Array.from(current.auto, ([sessionID, time]) => ({ sessionID, time }))
        return true
      })
      yield* Effect.logInfo("auto mode changed", { sessionID: input.sessionID, enabled: input.enabled })

      // Turning it off leaves nothing behind: no grant was ever written for an
      // auto-approval, so the durable allow list is untouched here by design.
      if (!input.enabled) return yield* resolveAuto(current, input.sessionID)

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
  deps: [EventV2Bridge.node, Storage.node, Config.node, Session.node],
})

export * as Permission from "."
