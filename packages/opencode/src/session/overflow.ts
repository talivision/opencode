import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { outputCeiling, outputFloor, safety, THINKING_TEXT_ROOM } from "./output-window"

const COMPACTION_BUFFER = 20_000

/**
 * Room the compaction summary call itself needs.
 *
 * The summary call runs with its thinking variant stripped (see compaction.ts),
 * so it needs text room only. If the usable window were allowed to fall below
 * this, compaction could no longer fit and the session would be stuck: unable
 * to answer, and unable to compact its way out.
 */
const COMPACTION_NEED = THINKING_TEXT_ROOM

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const ceiling = outputCeiling(input.model, input.outputTokenMax)
  const compaction = input.cfg.compaction

  // Escape hatch: reserve the full output ceiling on every call. Deliberately
  // uses the raw provider ceiling rather than the context-clamped one so the
  // trigger point is bit-identical to the pre-dynamic behavior, which is the
  // entire point of opting in.
  if (compaction?.dynamic_output === false) {
    const raw = ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax)
    const reserved = compaction.reserved ?? Math.min(COMPACTION_BUFFER, raw)
    return input.model.limit.input ? Math.max(0, input.model.limit.input - reserved) : Math.max(0, context - raw)
  }

  // Exact trigger override, honored on both branches.
  if (compaction?.reserved != null) return Math.max(0, (input.model.limit.input || context) - compaction.reserved)

  // Separate input budget: output does not consume input room, so the trigger
  // is unchanged by dynamic output sizing.
  if (input.model.limit.input) return Math.max(0, input.model.limit.input - Math.min(COMPACTION_BUFFER, ceiling))

  const floor = outputFloor({
    model: input.model,
    outputTokenMax: input.outputTokenMax,
    floor: compaction?.output_floor,
  })
  // Never hand more than half the window to the reserve. Without this a small
  // context -- now reachable whenever a subagent picks its own model -- reserves
  // its way to a usable window of 0 and compacts forever.
  const reserve = Math.min(Math.max(floor, COMPACTION_NEED) + safety(context), Math.floor(context / 2))
  return Math.max(0, context - reserve)
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}
