import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { createPcPortRouter } from "../../src/pcPort/router.js";

test("PC API status reports implemented and unverified capabilities honestly", async () => {
  const app = express();
  app.use("/api/pc/v1", createPcPortRouter({}));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  try {
    const response = await fetch("http://127.0.0.1:" + address.port + "/api/pc/v1/status");
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.service, "lso-pcport");
    assert.equal(payload.accountApi, "enabled");
    assert.equal(payload.sessionDirectory, "enabled");
    assert.equal(payload.gameTransport, "not-implemented");
    assert.equal(payload.gtaVPC161Compatibility, "not-verified");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
