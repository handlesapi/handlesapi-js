const { test } = require("node:test");
const assert = require("node:assert/strict");
const { HandlesApi, operations } = require("../dist/cjs/index.js");

test("CommonJS build exposes the client", async () => {
  const fetch = async () =>
    new Response(JSON.stringify({ data: { ok: true }, meta: { request_id: "r", generated_at: "", took_ms: 1 } }), {
      status: 200,
    });
  const api = new HandlesApi({ apiKey: "k", fetch });
  assert.equal(Object.keys(operations).length, 113);
  const res = await api.accountsPlatforms({});
  assert.deepEqual(res.data, { ok: true });
});
