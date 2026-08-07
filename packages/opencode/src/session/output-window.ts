import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Token } from "@/util/token"
import type { ModelMessage, Tool } from "ai"

/**
 * Flat token cost charged for a single media part.
 *
 * Media is billed by the provider on decoded dimensions, not on the length of
 * its base64 payload: a 1MB screenshot is ~1.6k tokens but ~350k characters.
 * Estimating it by string length would make a single attachment look like it
 * fills an entire context window, so every media part is charged a flat rate.
 */
export const MEDIA_TOKENS = 2_000

/**
 * Default lower bound on the output window we keep free.
 *
 * Nothing in the codebase reacts to `finish === "length"`, so a truncated reply
 * silently ends the turn looking complete. The floor is therefore sized to hold
 * a realistic file write rather than to be merely non-zero.
 */
export const DEFAULT_OUTPUT_FLOOR = 16_384

/**
 * Text room reserved on top of a thinking budget.
 *
 * Anthropic requires `max_tokens` to be strictly greater than
 * `thinking.budget_tokens`, so a request whose ceiling equals the budget is a
 * 400. It also leaves the model somewhere to put the actual answer.
 */
export const THINKING_TEXT_ROOM = 4_096

/**
 * Slack held back from the dynamic output window to absorb estimation error.
 *
 * Scales with the context so large windows, where the absolute error of a
 * character-count estimate is largest, get proportionally more room.
 */
export const safety = (context: number) => Math.max(2_000, Math.ceil(context * 0.02))

/** True when input and output are billed against one shared budget. */
const sharesContext = (model: Provider.Model) => !model.limit.input && model.limit.context !== 0

/**
 * Largest output window the provider will accept, with the zero-limit guard.
 *
 * A model that shares one budget can never usefully be asked for more output
 * than its whole context. That is reachable in practice: `maxOutputTokens`
 * resolves `limit.output === 0` to the 32k default, which on an 8k-context
 * model exceeds the entire window.
 */
export function outputCeiling(model: Provider.Model, outputTokenMax?: number) {
  const ceiling = ProviderTransform.maxOutputTokens(model, outputTokenMax)
  return sharesContext(model) ? Math.min(ceiling, model.limit.context) : ceiling
}

/**
 * Smallest output window we are willing to request.
 *
 * Derived from the ceiling rather than from `model.limit.output` directly:
 * 174 catalog models and most user-defined/local models report an output limit
 * of 0, and `maxOutputTokens` is the function that already resolves that to a
 * usable number.
 *
 * Capped at half a shared context so a small model -- reachable at LLM whim now
 * that subagents pick their own model per call -- cannot reserve away its own
 * input window and wedge the session into permanent compaction.
 */
export function outputFloor(input: { model: Provider.Model; outputTokenMax?: number; floor?: number }) {
  const ceiling = outputCeiling(input.model, input.outputTokenMax)
  const desired = Math.min(input.floor ?? Math.min(DEFAULT_OUTPUT_FLOOR, ceiling), ceiling)
  if (!sharesContext(input.model)) return desired
  return Math.max(1, Math.min(desired, Math.floor(input.model.limit.context / 2)))
}

/**
 * Output window to request for a single call.
 *
 * Models that publish a separate `limit.input` bill input and output against
 * independent budgets, so the full ceiling is always available and is always
 * requested. Models that publish only a combined `limit.context` share one
 * budget, so a fixed 32k output reservation costs 32k of usable context on
 * every call no matter how short the reply will be. For those, the request
 * shrinks to what is actually left, bounded below by the floor.
 */
export function requestedOutput(input: {
  model: Provider.Model
  estimatedInputTokens: number
  outputTokenMax?: number
  floor?: number
  thinkingBudget?: number
  dynamic?: boolean
}) {
  // Opted out: hand back the raw provider ceiling so behavior is bit-identical
  // to the pre-dynamic implementation.
  if (input.dynamic === false) return ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax)

  const ceiling = outputCeiling(input.model, input.outputTokenMax)
  if (!sharesContext(input.model)) return ceiling

  const base = outputFloor(input)
  const budget = input.thinkingBudget ?? 0
  // Thinking tokens are drawn from max_tokens, so the floor has to clear the
  // budget and still leave room for the response itself.
  const floor = budget
    ? Math.min(ceiling, Math.max(base, budget + Math.min(THINKING_TEXT_ROOM, ceiling - budget)))
    : base

  const context = input.model.limit.context
  return Math.min(ceiling, Math.max(floor, context - input.estimatedInputTokens - safety(context)))
}

const MEDIA_PART_TYPES = new Set(["image", "file", "media"])

function walk(value: unknown): number {
  if (value === null || value === undefined) return 0
  if (typeof value === "string") return Token.estimate(value)
  if (typeof value === "number" || typeof value === "boolean") return 1
  if (typeof value !== "object") return 0
  // Raw binary and URL payloads are media by construction.
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof URL) return MEDIA_TOKENS
  if (Array.isArray(value)) {
    let total = 0
    for (const item of value) total += walk(item)
    return total
  }
  const record = value as Record<string, unknown>
  // Charge media a flat rate and never descend into its payload.
  if (typeof record["type"] === "string" && MEDIA_PART_TYPES.has(record["type"])) return MEDIA_TOKENS
  if (typeof record["mediaType"] === "string" && ("data" in record || "url" in record || "image" in record))
    return MEDIA_TOKENS
  let total = 0
  for (const item of Object.values(record)) total += walk(item)
  return total
}

function schemaTokens(value: unknown): number {
  if (value === null || value === undefined) return 0
  const schema = (value as { jsonSchema?: unknown }).jsonSchema ?? value
  try {
    return Token.estimate(JSON.stringify(schema) ?? "")
  } catch {
    return 0
  }
}

/**
 * Estimate the input side of a request.
 *
 * Counts the system prompt and the serialized tool schemas, which the provider
 * bills but which do not appear in the message array on every code path — with
 * MCP servers attached the tool schemas alone are routinely 10-30k tokens.
 * Media is charged at a flat rate rather than by payload length.
 *
 * Only used to size the output window down. It is never a compaction trigger on
 * its own, so a wrong answer costs a suboptimal `max_tokens`, not a spurious
 * compaction: the real trigger reads measured token counts from the previous
 * assistant message.
 */
export function estimateInput(input: {
  system?: readonly string[]
  messages: readonly ModelMessage[]
  tools?: Record<string, Tool>
  /**
   * Input tokens the provider actually billed for the previous request, when
   * the caller has them. History only grows, so a measured count is a hard
   * lower bound and corrects the systematic undershoot of counting characters.
   */
  measuredInputTokens?: number
}) {
  let total = 0
  for (const text of input.system ?? []) total += Token.estimate(text)
  total += walk(input.messages)
  for (const [name, tool] of Object.entries(input.tools ?? {})) {
    total += Token.estimate(name)
    const described = tool as { description?: unknown; inputSchema?: unknown }
    if (typeof described.description === "string") total += Token.estimate(described.description)
    total += schemaTokens(described.inputSchema)
  }
  return Math.max(total, input.measuredInputTokens ?? 0)
}

const BUDGET_KEYS = new Set(["budgetTokens", "budget_tokens", "thinkingBudget", "tokenBudget"])

/**
 * Largest explicit thinking budget in a provider options blob.
 *
 * Only keys that are unambiguously thinking budgets count. `max_tokens` is
 * deliberately excluded: it is a legitimate provider option in its own right,
 * and treating it as a budget invents one where none exists.
 *
 * Returns 0 for effort/adaptive style reasoning (Claude >= 4.7, OpenAI
 * `reasoning_effort`), which has no numeric budget to find, so callers must not
 * use a zero result as proof that reasoning is disabled.
 */
export function thinkingBudget(input: unknown): number {
  if (!input || typeof input !== "object") return 0
  if (Array.isArray(input)) {
    let max = 0
    for (const item of input) max = Math.max(max, thinkingBudget(item))
    return max
  }
  let max = 0
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (BUDGET_KEYS.has(key) && typeof value === "number" && Number.isFinite(value) && value > 0) {
      max = Math.max(max, value)
      continue
    }
    max = Math.max(max, thinkingBudget(value))
  }
  return max
}
