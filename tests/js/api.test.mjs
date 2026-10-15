import test from "node:test";
import assert from "node:assert/strict";
import { createApi, ApiError } from "../../static/js/api.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function setup(handler) {
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  return { api: createApi({ fetchFn, csrfToken: () => "tok" }), calls };
}

test("GET requests carry no CSRF header; unsafe ones do", async () => {
  const { api, calls } = setup(() => json({ conversations: [], title: "x" }));
  await api.listConversations();
  await api.renameConversation("a b", "New");
  assert.equal(calls[0].init.headers["X-CSRFToken"], undefined);
  assert.equal(calls[1].init.headers["X-CSRFToken"], "tok");
  assert.equal(calls[1].init.method, "PATCH");
  assert.equal(calls[1].url, "/api/conversations/a%20b");
  assert.deepEqual(JSON.parse(calls[1].init.body), { title: "New" });
});

test("sendMessage posts multipart form data with message, conversation and images", async () => {
  const { api, calls } = setup(() => json({ ok: true }));
  const img = new File([new Uint8Array(3)], "pic.png", { type: "image/png" });
  await api.sendMessage({ message: "hi", conversationId: "c1", files: [img, img] });
  const form = calls[0].init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get("message"), "hi");
  assert.equal(form.get("conversation_id"), "c1");
  assert.equal(form.getAll("images").length, 2);
  assert.equal(calls[0].init.headers["Content-Type"], undefined, "the browser must set the multipart boundary");
});

test("omits conversation_id for a new chat", async () => {
  const { api, calls } = setup(() => json({}));
  await api.sendMessage({ message: "hi", conversationId: null });
  assert.equal(calls[0].init.body.has("conversation_id"), false);
});

test("server error messages are surfaced with their status", async () => {
  const { api } = setup(() => json({ error: "The configured model does not support images." }, 422));
  await assert.rejects(api.sendMessage({ message: "x" }), (e) => e instanceof ApiError && e.status === 422 && /does not support images/.test(e.message));
});

test("non-JSON error pages and network failures get friendly messages", async () => {
  let mode = "html";
  const { api } = setup(() => { if (mode === "net") throw new TypeError("fetch failed"); return new Response("<h1>Bad gateway</h1>", { status: 502 }); });
  await assert.rejects(api.getConversation("x"), (e) => e.status === 502 && /HTTP 502/.test(e.message));
  mode = "net";
  await assert.rejects(api.getConversation("x"), (e) => e.status === 0 && /Can't reach the server/.test(e.message));
});
