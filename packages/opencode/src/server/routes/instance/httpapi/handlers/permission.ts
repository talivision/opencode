import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "@/permission"
import { SessionID } from "@/session/schema"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { PermissionNotFoundError } from "../errors"

export const permissionHandlers = HttpApiBuilder.group(InstanceHttpApi, "permission", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Permission.Service

    const list = Effect.fn("PermissionHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const reply = Effect.fn("PermissionHttpApi.reply")(function* (ctx: {
      params: { requestID: PermissionV1.ID }
      payload: PermissionV1.ReplyBody
    }) {
      yield* svc
        .reply({
          requestID: ctx.params.requestID,
          reply: ctx.payload.reply,
          message: ctx.payload.message,
        })
        .pipe(
          Effect.catchTag("Permission.NotFoundError", (error) =>
            Effect.fail(
              new PermissionNotFoundError({
                requestID: String(error.requestID),
                message: `Permission request not found: ${error.requestID}`,
              }),
            ),
          ),
        )
      return true
    })

    const setAuto = Effect.fn("PermissionHttpApi.setAuto")(function* (ctx: {
      payload: { sessionID: SessionID; enabled: boolean }
    }) {
      return yield* svc.setAuto({ sessionID: ctx.payload.sessionID, enabled: ctx.payload.enabled })
    })

    const getAuto = Effect.fn("PermissionHttpApi.getAuto")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* svc.getAuto(ctx.params.sessionID)
    })

    const autoLog = Effect.fn("PermissionHttpApi.autoLog")(function* () {
      return yield* svc.autoLog()
    })

    const grants = Effect.fn("PermissionHttpApi.grants")(function* () {
      return yield* svc.grants()
    })

    const revoke = Effect.fn("PermissionHttpApi.revoke")(function* (ctx: {
      payload: { permission?: string; pattern?: string }
    }) {
      return yield* svc.revoke({ permission: ctx.payload.permission, pattern: ctx.payload.pattern })
    })

    return handlers
      .handle("list", list)
      .handle("reply", reply)
      .handle("setAuto", setAuto)
      .handle("getAuto", getAuto)
      .handle("autoLog", autoLog)
      .handle("grants", grants)
      .handle("revoke", revoke)
  }),
)
