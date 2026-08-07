import { describe, expect, test } from "bun:test"
import { isContextOverflow } from "../src"

describe("provider error classification", () => {
  test("classifies provider token limit messages as context overflow", () => {
    const messages = [
      "tokens in request more than max tokens allowed",
      '{"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
      "Requested token count exceeds the model's maximum context length of 131072 tokens.",
      "Input length (265330) exceeds model's maximum context length (262144).",
      "Input length 131393 exceeds the maximum allowed input length of 131040 tokens.",
      "The input (516368 tokens) is longer than the model's context length (262144 tokens).",
      "Prompt has 5,958,968 tokens, but the configured context size is 256,000 tokens",
      "Too many tokens",
      "Token limit exceeded",
    ]

    expect(messages.every(isContextOverflow)).toBe(true)
  })

  test("classifies Anthropic's combined input + max_tokens rejection as context overflow", () => {
    // Anthropic rejects on input + max_tokens against the shared window. The
    // wording matches none of the "context length"/"context window" patterns:
    // it says "exceed context limit". Left unclassified it is a plain
    // non-retryable 400, so the session hard-stops instead of compacting --
    // on the largest provider class, and on exactly the requests the dynamic
    // output window is meant to size.
    const messages = [
      "input length and `max_tokens` exceed context limit: 199000 + 32000 > 200000, decrease input length or `max_tokens` and try again",
      '{"type":"error","error":{"type":"invalid_request_error","message":"input length and `max_tokens` exceed context limit: 214523 + 64000 > 200000, decrease input length or `max_tokens` and try again"}}',
      "input length and max_tokens exceed context limit: 1048576 + 32000 > 1000000",
    ]

    expect(messages.every(isContextOverflow)).toBe(true)
  })

  test("does not classify rate limits as context overflow", () => {
    const messages = [
      "Throttling error: Too many tokens, please wait before trying again.",
      "Rate limit exceeded, please retry after 30 seconds.",
      "Too many requests. Please slow down.",
    ]

    expect(messages.some(isContextOverflow)).toBe(false)
  })
})
