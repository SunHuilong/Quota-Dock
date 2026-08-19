"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { createResponseErrorMessage, normalizeBodyForJson } = require("./quota-core.js");

function createResponseError(message, detail, sanitize) {
  if (sanitize) {
    const status = detail && detail.statusCode ? `（HTTP ${detail.statusCode}）` : "";
    return new Error(`${message}${status}`);
  }

  return new Error(createResponseErrorMessage(message, detail));
}

function requestJson(config, timeoutMs, options) {
  const sanitize = Boolean(options && options.sanitizeErrors);

  return new Promise((resolve, reject) => {
    const parsed = new URL(config.url);
    const client = parsed.protocol === "http:" ? http : https;
    const request = client.request(
      parsed,
      {
        method: config.method || "GET",
        headers: config.headers || {}
      },
      (response) => {
        const chunks = [];
        const detail = {
          url: config.url,
          statusCode: response.statusCode,
          contentType: response.headers["content-type"],
          body: ""
        };

        response.on("data", (chunk) => {
          chunks.push(Buffer.from(chunk));
        });

        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          detail.body = body;

          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(createResponseError("请求返回非成功状态", detail, sanitize));
            return;
          }

          try {
            resolve(JSON.parse(normalizeBodyForJson(body)));
          } catch {
            reject(createResponseError("响应不是有效的 JSON", detail, sanitize));
          }
        });
      }
    );

    request.on("error", (error) => {
      if (sanitize) {
        const code = error && error.code ? `（${error.code}）` : "";
        reject(new Error(`网络请求失败${code}`));
        return;
      }
      reject(error);
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("请求超时"));
    });
    if (config.body) {
      request.write(config.body);
    }
    request.end();
  });
}

module.exports = {
  requestJson
};
