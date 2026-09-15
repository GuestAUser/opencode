import { describe, expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import path from "path"

// Bun applies a patch only to the exact `name@version` named in
// `patchedDependencies`. Bumping the dependency without regenerating the patch
// does not fail `bun install`; the patch just stops applying and the runtime
// silently loses whatever the patch fixed. This pins the two together for the
// packages that ship in the CLI.
const root = path.resolve(import.meta.dir, "../../..")
const workspaces = ["packages/opencode", "packages/core"]
const patched = (await Bun.file(path.join(root, "package.json")).json()).patchedDependencies as Record<string, string>

describe("patched dependencies", () => {
  for (const key of Object.keys(patched)) {
    const at = key.lastIndexOf("@")
    const name = key.slice(0, at)
    const version = key.slice(at + 1)

    test(`${key} matches the installed version`, async () => {
      expect(await Bun.file(path.join(root, patched[key])).exists()).toBe(true)
      for (const workspace of workspaces) {
        const file = Bun.file(path.join(root, workspace, "node_modules", name, "package.json"))
        if (!(await file.exists())) continue
        const installed = (await file.json()).version as string
        expect(installed, `${workspace} resolves ${name}@${installed}; patch is for ${version}`).toBe(version)
      }
    })
  }

  test.each([
    {
      api: "chat",
      tier: "fast",
      response: {
        id: "chat-1",
        created: 0,
        model: "custom-model",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    },
    {
      api: "responses",
      tier: "flex",
      response: {
        id: "response-1",
        created_at: 0,
        model: "custom-model",
        object: "response",
        output: [],
        usage: { input_tokens: 1, output_tokens: 0 },
        status: "completed",
      },
    },
  ] as const)("OpenAI $api preserves $tier service tier for custom models", async ({ api, tier, response }) => {
    let body: Record<string, unknown> | undefined
    const mockFetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        body = JSON.parse(String(init?.body))
        return Response.json(response)
      },
      { preconnect: fetch.preconnect },
    )
    const openai = createOpenAI({ apiKey: "test", fetch: mockFetch })
    const model = api === "chat" ? openai.chat("custom-model") : openai.responses("custom-model")

    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      providerOptions: { openai: { serviceTier: tier } },
    })

    expect(body?.service_tier).toBe(tier)
  })
})
