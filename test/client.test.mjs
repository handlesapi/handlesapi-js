import { test } from "node:test";
import assert from "node:assert/strict";
import { HandlesApi, HandlesApiError, HandlesApiConnectionError, operations } from "../dist/esm/index.js";

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const ok = (data, extra = {}) =>
  json(200, { data, meta: { request_id: "req_1", generated_at: "2026-01-01T00:00:00Z", took_ms: 3, ...extra } }, {
    "x-credits-cost": "1",
    "x-credits-remaining": "99",
    "x-credits-period-end": "2100-01-01T00:00:00.000Z",
    "x-ratelimit-limit": "10",
    "x-ratelimit-remaining": "9",
    "x-ratelimit-reset": "1795713960",
  });

function client(handler, options = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(calls.length, String(url), init);
  };
  return { api: new HandlesApi({ apiKey: "hk_live_test", fetch, maxRetries: 2, ...options }), calls };
}

test("covers every endpoint in the spec", () => {
  assert.equal(Object.keys(operations).length, 113);
  const api = new HandlesApi({ apiKey: "k" });
  for (const name of Object.keys(operations)) assert.equal(typeof api[name], "function", name);
});

test("fills path parameters, sends the bearer key and parses credit headers", async () => {
  const { api, calls } = client(() => ok({ handle: "nasa" }));
  const res = await api.accountsCheck({ platform: "x", handle: "nasa" });
  assert.equal(calls[0].url, "https://api.handlesapi.com/v1/accounts/x/nasa");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.Authorization, "Bearer hk_live_test");
  assert.deepEqual(res.data, { handle: "nasa" });
  assert.deepEqual(res.credits, { cost: 1, remaining: 99, periodEnd: "2100-01-01T00:00:00.000Z" });
  assert.deepEqual(res.rateLimit, { limit: 10, remaining: 9, reset: 1795713960 });
  assert.equal(res.requestId, "req_1");
});

test("encodes path values and serialises query parameters", async () => {
  const { api, calls } = client(() => ok({}));
  await api.xUsersTweets({ handle: "a b", limit: 5, include_replies: true });
  assert.equal(calls[0].url, "https://api.handlesapi.com/v1/x/users/a%20b/tweets?limit=5&include_replies=true");
});

test("POST sends only body parameters as JSON", async () => {
  const { api, calls } = client(() => ok({ requested: 1 }));
  await api.accountsBulk({ targets: [{ platform: "x", handle: "nasa" }] });
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].url, "https://api.handlesapi.com/v1/accounts/check");
  assert.equal(calls[0].init.body, JSON.stringify({ targets: [{ platform: "x", handle: "nasa" }] }));
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
});

test("throws HandlesApiError with the stable code and request id", async () => {
  const { api } = client(() =>
    json(404, { error: { code: "not_found", message: "No account matches that handle.", request_id: "req_9" } }),
  );
  await assert.rejects(api.accountsCheck({ platform: "x", handle: "nobody" }), (e) => {
    assert.ok(e instanceof HandlesApiError);
    assert.equal(e.status, 404);
    assert.equal(e.code, "not_found");
    assert.equal(e.requestId, "req_9");
    assert.equal(e.retryable, false);
    return true;
  });
});

test("does not retry 402 quota_exceeded or 422 invalid_request", async () => {
  for (const [status, code] of [
    [402, "quota_exceeded"],
    [422, "invalid_request"],
  ]) {
    const { api, calls } = client(() => json(status, { error: { code, message: "no", request_id: "r" } }));
    await assert.rejects(api.accountsPlatforms({}), (e) => e.code === code);
    assert.equal(calls.length, 1, code);
  }
});

test("retries 5xx with backoff and then succeeds", async () => {
  const { api, calls } = client((n) =>
    n < 3 ? json(503, { error: { code: "upstream_timeout", message: "slow", request_id: "r" } }) : ok({ fine: true }),
  );
  const res = await api.accountsPlatforms({}, { maxRetries: 2 });
  assert.equal(calls.length, 3);
  assert.deepEqual(res.data, { fine: true });
});

test("honours Retry-After on 429", async () => {
  const { api, calls } = client((n) =>
    n === 1
      ? json(429, { error: { code: "rate_limited", message: "slow down", request_id: "r" } }, { "retry-after": "0" })
      : ok({}),
  );
  await api.accountsPlatforms({});
  assert.equal(calls.length, 2);
});

test("throws instead of sleeping through a long Retry-After", async () => {
  const { api, calls } = client(() =>
    json(429, { error: { code: "rate_limited", message: "slow down", request_id: "r" } }, { "retry-after": "120" }),
  );
  await assert.rejects(api.accountsPlatforms({}), (e) => e.code === "rate_limited" && e.retryAfter === 120);
  assert.equal(calls.length, 1);
});

test("gives up after maxRetries and surfaces the last error", async () => {
  const { api, calls } = client(() => json(502, { error: { code: "upstream_error", message: "bad", request_id: "r" } }));
  await assert.rejects(api.accountsPlatforms({}, { maxRetries: 1 }), (e) => e.code === "upstream_error");
  assert.equal(calls.length, 2);
});

test("a non-JSON gateway error becomes code unknown and a 5xx is retried", async () => {
  const { api, calls } = client((n) => (n === 1 ? new Response("Bad gateway", { status: 502 }) : ok({})));
  await api.accountsPlatforms({});
  assert.equal(calls.length, 2);
});

test("network failures are retried and then raised as HandlesApiConnectionError", async () => {
  const { api, calls } = client(() => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(
    api.accountsPlatforms({}, { maxRetries: 1 }),
    (e) => e instanceof HandlesApiConnectionError && !e.timedOut,
  );
  assert.equal(calls.length, 2);
});

test("paginate follows next_cursor until it is null", async () => {
  const pages = [
    ok({ n: 1 }, { page: { limit: 2, count: 2, next_cursor: "c2" } }),
    ok({ n: 2 }, { page: { limit: 2, count: 2, next_cursor: "c3" } }),
    ok({ n: 3 }, { page: { limit: 2, count: 1, next_cursor: null } }),
  ];
  const { api, calls } = client((n) => pages[n - 1]);
  const seen = [];
  for await (const page of api.paginate("xUsersTweets", { handle: "nasa", limit: 2 })) seen.push(page.data.n);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.match(calls[1].url, /cursor=c2/);
  assert.match(calls[2].url, /cursor=c3/);
});

test("paginate stops at maxPages", async () => {
  const { api, calls } = client(() => ok({}, { page: { limit: 1, count: 1, next_cursor: "more" } }));
  let n = 0;
  for await (const _page of api.paginate("xUsersTweets", { handle: "nasa" }, { maxPages: 2 })) n++;
  assert.equal(n, 2);
  assert.equal(calls.length, 2);
});

test("requires an API key", () => {
  const saved = process.env.HANDLES_API_KEY;
  delete process.env.HANDLES_API_KEY;
  try {
    assert.throws(() => new HandlesApi(), /key missing/);
  } finally {
    if (saved !== undefined) process.env.HANDLES_API_KEY = saved;
  }
});
