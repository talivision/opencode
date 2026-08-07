import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "@/permission"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { PermissionNotFoundError, SessionNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/permission"
const ReplyPayload = Schema.Struct({
  reply: PermissionV1.Reply,
  message: Schema.optional(Schema.String),
})

export const AutoPayload = Schema.Struct({
  sessionID: SessionID,
  enabled: Schema.Boolean,
})

export const AutoStatus = Schema.Struct({
  enabled: Schema.Boolean,
  explicit: Schema.Boolean,
  source: Schema.optional(SessionID),
}).annotate({ identifier: "PermissionAutoStatus" })

export const RevokePayload = Schema.Struct({
  permission: Schema.optional(Schema.String),
  pattern: Schema.optional(Schema.String),
})

export const PermissionApi = HttpApi.make("permission")
  .add(
    HttpApiGroup.make("permission")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(PermissionV1.Request), "List of pending permissions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.list",
            summary: "List pending permissions",
            description: "Get all pending permission requests across all sessions.",
          }),
        ),
        HttpApiEndpoint.post("reply", `${root}/:requestID/reply`, {
          params: { requestID: PermissionV1.ID },
          query: WorkspaceRoutingQuery,
          payload: ReplyPayload,
          success: described(Schema.Boolean, "Permission processed successfully"),
          error: [HttpApiError.BadRequest, PermissionNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.reply",
            summary: "Respond to permission request",
            description: "Approve or deny a permission request from the AI assistant.",
          }),
        ),
        HttpApiEndpoint.post("setAuto", `${root}/auto`, {
          query: WorkspaceRoutingQuery,
          payload: AutoPayload,
          success: described(AutoStatus, "Resulting auto-mode status"),
          error: [SessionNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.setAuto",
            summary: "Toggle permission auto mode for a session",
            description:
              "Turn auto mode on or off for a session. The session must exist. Descendant sessions (subagents) inherit it, requests already pending in the session tree are released, and explicit deny rules are still enforced. Emits permission.auto.changed.",
          }),
        ),
        HttpApiEndpoint.get("getAuto", `${root}/auto/:sessionID`, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(AutoStatus, "Effective auto-mode status for the session"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.getAuto",
            summary: "Get permission auto mode for a session",
            description: "Effective auto-mode status, resolving inheritance from ancestor sessions.",
          }),
        ),
        HttpApiEndpoint.get("autoLog", `${root}/auto-log`, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Permission.AutoApproval), "Audit trail of auto-approved permissions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.autoLog",
            summary: "List auto-approved permissions",
            description: "Audit trail of everything auto mode approved without asking, for after-the-fact review.",
          }),
        ),
        HttpApiEndpoint.get("grants", `${root}/grant`, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(PermissionV1.Rule), "Runtime permission grants in effect"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.grants",
            summary: "List permission grants",
            description: 'Grants produced by answering "always", including the ones restored from the project store.',
          }),
        ),
        HttpApiEndpoint.post("revoke", `${root}/grant/revoke`, {
          query: WorkspaceRoutingQuery,
          payload: RevokePayload,
          success: described(Schema.Number, "Number of grants removed"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.revoke",
            summary: "Revoke permission grants",
            description:
              "Remove runtime grants matching permission and/or pattern (omit both to remove all) from memory and from the project store.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "permission",
          description: "Experimental HttpApi permission routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
