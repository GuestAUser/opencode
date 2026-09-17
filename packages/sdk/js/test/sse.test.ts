import { expect, test } from "bun:test"

for (const version of ["v1", "v2"] as const) {
  const { createSseClient } = await (version === "v1"
    ? import("../src/gen/core/serverSentEvents.gen")
    : import("../src/v2/gen/core/serverSentEvents.gen"))

  test(`${version} aborts an HTTP event stream without an unhandled cancellation rejection`, async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"type":"ready"}\n\n'))
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const abort = new AbortController()
    try {
      const { stream } = createSseClient({
        url: server.url.toString(),
        signal: abort.signal,
        sseMaxRetryAttempts: 0,
      })
      expect(await stream.next()).toEqual({ value: { type: "ready" }, done: false })
      const pending = stream.next()
      await Bun.sleep(10)
      abort.abort()
      expect(await pending).toEqual({ value: undefined, done: true })
      await Bun.sleep(10)
    } finally {
      abort.abort()
      await server.stop(true)
    }
  })

  test(`${version} still reports HTTP event stream failures`, async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 503 }),
    })
    try {
      const errors: unknown[] = []
      const { stream } = createSseClient({
        url: server.url.toString(),
        sseMaxRetryAttempts: 0,
        onSseError: (error) => errors.push(error),
      })
      expect(await stream.next()).toEqual({ value: undefined, done: true })
      expect(errors).toEqual([new Error("SSE failed: 503 Service Unavailable")])
    } finally {
      await server.stop(true)
    }
  })
}
