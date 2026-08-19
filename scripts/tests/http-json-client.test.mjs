import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { require } from "./helpers.mjs";

const { requestJson } = require("../../public/libs/http-json-client.js");

test("sanitized HTTP errors retain statusCode without exposing response details", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(403, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: "forbidden", secret: "sk-response-secret" }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/quota?token=sk-url-secret`;

  await assert.rejects(
    requestJson({ url, method: "GET" }, 1000, { sanitizeErrors: true }),
    (error) => {
      assert.equal(error.statusCode, 403);
      assert.equal(error.message, "请求返回非成功状态（HTTP 403）");
      assert.doesNotMatch(error.message, /sk-response-secret|sk-url-secret|forbidden/);
      return true;
    }
  );
});
