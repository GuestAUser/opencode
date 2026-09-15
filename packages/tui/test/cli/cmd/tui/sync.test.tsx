/** @jsxImportSource @opentui/solid */
import { describe, expect, spyOn, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { mount, wait } from "./sync-fixture"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

describe("tui sync", () => {
  test.each(
    ["/config", "/session", "/mcp", "/config,/session", "lsp.updated"].flatMap((endpoint) =>
      (["shutdown", "network", "unrelated abort"] as const).map((failure) => ({ endpoint, failure })),
    ),
  )("handles $failure while reading $endpoint on exit", async ({ endpoint, failure }) => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let pending = false
    let started = 0
    const endpoints = (endpoint === "lsp.updated" ? "/lsp" : endpoint).split(",")
    const error = failure === "network" ? new Error("Network failure") : new DOMException("Other abort", "AbortError")
    const errors = spyOn(console, "error").mockImplementation(() => {})
    const { app, sync, emit } = await mount((url, request) => {
      if (!pending || !endpoints.includes(url.pathname)) return
      return new Response(
        new ReadableStream({
          start(controller) {
            started++
            request.signal.addEventListener(
              "abort",
              () => controller.error(failure === "shutdown" ? request.signal.reason : error),
              { once: true },
            )
          },
        }),
        { headers: { "content-type": "application/json" } },
      )
    }, tmp.path)
    try {
      pending = true
      const bootstrap = endpoint === "lsp.updated"
        ? Promise.resolve(emit({ directory: "/tmp/other", payload: { id: "evt_lsp_exit", type: "lsp.updated", properties: {} } }))
        : sync.bootstrap({ fatal: false }).then(() => undefined, (error: unknown) => error)
      await wait(() => started === endpoints.length)
      app.renderer.destroy()
      expect(await bootstrap).toBe(failure === "shutdown" || endpoint === "lsp.updated" ? undefined : error)
      await Bun.sleep(20)
      expect(errors.mock.calls).toEqual(
        failure === "shutdown"
          ? []
          : endpoint === "lsp.updated"
            ? [["Failed to refresh LSP status", error]]
            : [["tui bootstrap failed", { error: error.message, name: error.name, stack: error.stack }]],
      )
    } finally {
      app.renderer.destroy()
      errors.mockRestore()
    }
  })

  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount(undefined, tmp.path)

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/tui")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
    } finally {
      app.renderer.destroy()
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount(undefined, tmp.path)

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
    }
  })
})
