import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { HttpError, QueuedHttpClientFactory } from "./queueHttpClient";

const factory = (maxRequestsPerWindow: number) =>
  new QueuedHttpClientFactory({
    baseURL: "https://api.spotify.test",
    headers: {},
    maxRequestsPerWindow,
  });

test("import requests wait while a login request uses the reserved budget", async () => {
  mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (url) => {
    paths.push(new URL(url.toString()).pathname);
    return Response.json({ ok: true });
  };

  try {
    const client = factory(3).createClient({});
    await client.get("/import-1");
    const secondImport = client.get("/import-2");
    await client.get("/login", { priority: "high" });
    assert.deepEqual(paths, ["/import-1", "/login"]);

    mock.timers.tick(30_001);
    await secondImport;
    assert.deepEqual(paths, ["/import-1", "/login", "/import-2"]);
  } finally {
    globalThis.fetch = originalFetch;
    mock.timers.reset();
  }
});

test("rate-limit responses cool down the shared queue and retry", async () => {
  mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? Response.json(
          { error: { status: 429 } },
          { status: 429, headers: { "Retry-After": "2" } },
        )
      : Response.json({ ok: true });
  };

  try {
    const client = factory(10).createClient({});
    const request = client.get("/track");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    mock.timers.tick(1_999);
    assert.equal(calls, 1);
    mock.timers.tick(1);
    await request;
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    mock.timers.reset();
  }
});

test("development quota exhaustion fails without repeated Spotify calls", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json(
      { error: { status: 429, reason: "QUOTA_EXCEEDED" } },
      { status: 429 },
    );
  };

  try {
    const client = factory(10).createClient({});
    await assert.rejects(client.get("/track"), (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 429);
      return true;
    });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
