import { describe, expect, it } from "vitest"
import { OpenCodeGoProvider } from "./opencode-go"

const provider = new OpenCodeGoProvider()

describe("OpenCodeGoProvider.classifyError", () => {
  it("GoUsageLimitError(429) 触发切号并标记配额类型", () => {
    const body = JSON.stringify({ error: { type: "GoUsageLimitError" }, metadata: { limitName: "5 hour" } })
    expect(provider.classifyError(429, body, new Headers())).toMatchObject({
      shouldSwitchAccount: true,
      quotaKind: "FIVE_HOUR",
      errorType: "GoUsageLimitError",
    })
  })

  it("model not supported 触发切号", () => {
    const body = JSON.stringify({ error: { message: "model foo is not supported" } })
    expect(provider.classifyError(400, body, new Headers())).toMatchObject({
      shouldSwitchAccount: true,
      errorType: "ModelError",
    })
  })

  it("Console Go 聚合上游间歇性 403（包装成 400 bad_request_error）触发切号", () => {
    const body = JSON.stringify({
      error: { message: "Error from provider (Console Go): Upstream request failed: [bad_request_error] invalid param: remote returned status 403 (2013)" },
    })
    expect(provider.classifyError(400, body, new Headers())).toMatchObject({
      shouldSwitchAccount: true,
      errorType: "UpstreamForbidden",
    })
  })

  it("body 含 returned status 403 但大小写不同也触发切号", () => {
    const body = JSON.stringify({ error: { message: "invalid param: Remote Returned Status 403 (2013)" } })
    expect(provider.classifyError(400, body, new Headers())).toMatchObject({
      shouldSwitchAccount: true,
      errorType: "UpstreamForbidden",
    })
  })

  it("纯 401/403 仍视为凭证错误，不切号", () => {
    expect(provider.classifyError(401, "{}", new Headers())).toMatchObject({
      shouldSwitchAccount: false,
      errorType: "AuthenticationError",
    })
    expect(provider.classifyError(403, "{}", new Headers())).toMatchObject({
      shouldSwitchAccount: false,
      errorType: "AuthenticationError",
    })
  })

  it("无关错误返回 null", () => {
    expect(provider.classifyError(500, "internal error", new Headers())).toBeNull()
    expect(provider.classifyError(200, "{}", new Headers())).toBeNull()
  })
})
