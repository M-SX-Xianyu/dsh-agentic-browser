import test from "node:test";
import assert from "node:assert/strict";
import { BrowserHost, BrowserSession, sameLoopbackOrigin, validateBrowserAddress } from "../index.js";

const APPLICATION_ORIGIN = "http://127.0.0.1:54685";
const SESSION_ID = "agent-session-1";
const CLIENT_ID = "client-1234567890abcd";
const OTHER_CLIENT_ID = "client-abcdefghijkl";

function createResponse() {
  return {
    writableEnded: false,
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.writableEnded = true;
      this.body = JSON.parse(body);
    },
  };
}

function createHost(t, origin = APPLICATION_ORIGIN) {
  const agent = { id: SESSION_ID };
  const agents = new Map([[SESSION_ID, agent]]);
  let currentOrigin = origin;
  const ctx = {
    webServer: { getOrigin: () => currentOrigin },
    get(name) {
      return name === "agents" ? { get: (id) => agents.get(id) } : undefined;
    },
    on() { return () => {}; },
  };
  const host = new BrowserHost(ctx);
  const session = new BrowserSession(agent, host);
  host.sessions.set(SESSION_ID, session);
  t.after(() => host.dispose());
  return { host, session, setOrigin(next) { currentOrigin = next; } };
}

function registrationRequest({ method = "POST", origin = APPLICATION_ORIGIN, clientId = CLIENT_ID } = {}) {
  return {
    method,
    headers: origin === null ? {} : { origin },
    url: `/dsh-agentic-browser/api/register?sessionId=${encodeURIComponent(SESSION_ID)}&clientId=${encodeURIComponent(clientId)}`,
  };
}

function authenticatedRequest({ method = "POST", origin = APPLICATION_ORIGIN, clientId = CLIENT_ID, capability } = {}) {
  return {
    method,
    headers: origin === null ? {} : { origin },
    url: `/dsh-agentic-browser/api/disconnect?sessionId=${encodeURIComponent(SESSION_ID)}&clientId=${encodeURIComponent(clientId)}&capability=${encodeURIComponent(capability)}`,
  };
}

test("registration requires POST and rejects untrusted Origins while tolerating the Origin-less bridge", (t) => {
  const { host, session } = createHost(t);

  const wrongOrigin = createResponse();
  host.registerClient(registrationRequest({ origin: "https://attacker.example" }), wrongOrigin);
  assert.equal(wrongOrigin.status, 403);
  assert.equal(wrongOrigin.body.error, "origin-rejected");
  assert.equal(wrongOrigin.body.expected, APPLICATION_ORIGIN);
  assert.equal(wrongOrigin.body.received, "https://attacker.example");
  assert.ok(wrongOrigin.body.trusted.includes(APPLICATION_ORIGIN));
  assert.ok(wrongOrigin.body.trusted.includes("http://localhost:54685"));
  assert.equal(session.clientInstance, null);

  // The Desktop dsh-app:// bridge forwards requests without an Origin header;
  // registration must still succeed there and return the capability.
  const bridgeRegistration = createResponse();
  host.registerClient(registrationRequest({ origin: null }), bridgeRegistration);
  assert.equal(bridgeRegistration.status, 200);
  assert.equal(bridgeRegistration.body.capability, session.capability);
  assert.equal(session.clientInstance, CLIENT_ID);

  const wrongMethod = createResponse();
  host.registerClient(registrationRequest({ method: "GET" }), wrongMethod);
  assert.equal(wrongMethod.status, 405);
});

test("registration accepts loopback aliases of the application origin", (t) => {
  const { host, session } = createHost(t);

  const localhostForm = createResponse();
  host.registerClient(registrationRequest({ origin: "http://localhost:54685" }), localhostForm);
  assert.equal(localhostForm.status, 200);
  assert.equal(localhostForm.body.capability, session.capability);
  assert.equal(session.clientInstance, CLIENT_ID);

  const ipv6Form = createResponse();
  host.registerClient(registrationRequest({ origin: "http://[::1]:54685" }), ipv6Form);
  assert.equal(ipv6Form.status, 200);
});

test("loopback alias acceptance does not extend to other hosts, ports, or schemes", (t) => {
  const { host } = createHost(t);

  for (const origin of [
    "http://localhost:54686",
    "http://127.0.0.1:54686",
    "https://localhost:54685",
    "https://127.0.0.1:54685",
    "http://localhost.evil.example:54685",
    "http://127.0.0.1.evil.example:54685",
  ]) {
    const rejected = createResponse();
    host.registerClient(registrationRequest({ origin }), rejected);
    assert.equal(rejected.status, 403, origin);
  }
});

test("a Host that serves the localhost form accepts the 127.0.0.1 alias", (t) => {
  const { host, session } = createHost(t, "http://localhost:54685");

  const registered = createResponse();
  host.registerClient(registrationRequest({ origin: "http://127.0.0.1:54685" }), registered);
  assert.equal(registered.status, 200);
  assert.equal(registered.body.capability, session.capability);
});

test("origin trust follows a live web-server origin change", (t) => {
  const { host, setOrigin } = createHost(t);
  setOrigin("http://127.0.0.1:54321");

  const stalePort = createResponse();
  host.registerClient(registrationRequest({ origin: "http://127.0.0.1:54685" }), stalePort);
  assert.equal(stalePort.status, 200);

  const newPortAlias = createResponse();
  host.registerClient(registrationRequest({ origin: "http://localhost:54321" }), newPortAlias);
  assert.equal(newPortAlias.status, 200);

  const foreignPort = createResponse();
  host.registerClient(registrationRequest({ origin: "http://localhost:9999" }), foreignPort);
  assert.equal(foreignPort.status, 403);
});

test("authenticated routes accept the loopback alias origin", async (t) => {
  const { host, session } = createHost(t);
  session.clientInstance = CLIENT_ID;

  const disconnected = createResponse();
  await host.handleDisconnect(authenticatedRequest({ origin: "http://localhost:54685", capability: session.capability }), disconnected);
  assert.equal(disconnected.status, 200);
  assert.deepEqual(disconnected.body, { ok: true });
});

test("authenticated routes tolerate the Origin-less Desktop bridge", async (t) => {
  const { host, session } = createHost(t);
  session.clientInstance = CLIENT_ID;

  const disconnected = createResponse();
  await host.handleDisconnect(authenticatedRequest({ origin: null, capability: session.capability }), disconnected);
  assert.equal(disconnected.status, 200);
  assert.deepEqual(disconnected.body, { ok: true });
});

test("agent tool present requests are raised and cleared by registration", (t) => {
  const { host, session } = createHost(t);

  const idle = createResponse();
  host.handlePresent({ method: "GET" }, idle);
  assert.equal(idle.status, 200);
  assert.equal(idle.body.open, false);

  host.requestPresent(session);
  const raised = createResponse();
  host.handlePresent({ method: "GET" }, raised);
  assert.equal(raised.body.open, true);

  const registered = createResponse();
  host.registerClient(registrationRequest({ origin: null }), registered);
  assert.equal(registered.status, 200);
  const cleared = createResponse();
  host.handlePresent({ method: "GET" }, cleared);
  assert.equal(cleared.body.open, false);

  // An already-connected panel must not re-raise the auto-open request.
  session.presentRequested = false;
  host.requestPresent(session);
  assert.equal(session.presentRequested, false);

  const wrongMethod = createResponse();
  host.handlePresent({ method: "POST" }, wrongMethod);
  assert.equal(wrongMethod.status, 405);
});

test("screenshot upload is authenticated and persisted", async (t) => {
  const { Readable } = await import("node:stream");
  const { readFileSync, existsSync } = await import("node:fs");
  const requestWithBody = (url, body) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = "POST";
    req.headers = { "content-type": "application/json" };
    req.url = url;
    return req;
  };
  const { host, session } = createHost(t);
  session.clientInstance = CLIENT_ID;
  const authUrl = authenticatedRequest({ capability: session.capability }).url;

  const pngBytes = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const saved = createResponse();
  await host.handleShot(requestWithBody(authUrl, { png: pngBytes.toString("base64") }), saved);
  assert.equal(saved.status, 200);
  assert.equal(typeof saved.body.path, "string");
  assert.ok(saved.body.path.endsWith(".png"));
  assert.equal(existsSync(saved.body.path), true);
  assert.deepEqual(readFileSync(saved.body.path), pngBytes);
  t.after(() => {
    try { require("node:fs").unlinkSync(saved.body.path); } catch { /* best-effort */ }
  });

  const invalid = createResponse();
  await host.handleShot(requestWithBody(authUrl, { png: "!!!not-base64!!!" }), invalid);
  assert.equal(invalid.status, 400);

  const missing = createResponse();
  await host.handleShot(requestWithBody(authUrl, {}), missing);
  assert.equal(missing.status, 400);

  const getMethod = createResponse();
  host.handlePresent({ method: "GET" }, getMethod);
  assert.equal(getMethod.status, 200);
});

test("event and result handlers accept valid payloads", async (t) => {
  const { Readable } = await import("node:stream");
  const requestWithBody = (url, body) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = "POST";
    req.headers = { "content-type": "application/json" };
    req.url = url;
    return req;
  };
  const { host, session } = createHost(t);
  session.clientInstance = CLIENT_ID;
  const authUrl = authenticatedRequest({ capability: session.capability }).url;

  const created = createResponse();
  await host.handleEvent(requestWithBody(authUrl, { kind: "new" }), created);
  assert.equal(created.status, 200);
  const tabId = session.activeTabId;
  assert.ok(tabId);

  const opened = createResponse();
  await host.handleEvent(requestWithBody(authUrl, { kind: "open", url: "https://example.com/" }), opened);
  assert.equal(opened.status, 200);
  assert.equal(session.tabs.get(session.activeTabId).url, "https://example.com/");

  const updated = createResponse();
  await host.handleEvent(requestWithBody(authUrl, { kind: "tab-update", tabId, title: "Bing", loading: false }), updated);
  assert.equal(updated.status, 200);
  assert.equal(session.tabs.get(tabId).title, "Bing");

  const settled = createResponse();
  await host.handleResult(requestWithBody(authUrl, { id: "1", ok: true, value: { message: "done" } }), settled);
  // No command "1" is pending: an unknown id settles as 409, not a handler crash.
  assert.equal(settled.status, 409);
});

test("the application-origin open guard covers loopback aliases", () => {
  const blocked = validateBrowserAddress("http://localhost:54685/chat", "http://127.0.0.1:54685");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "application-origin");

  const blockedReverse = validateBrowserAddress("http://127.0.0.1:54685/", "http://localhost:54685");
  assert.equal(blockedReverse.ok, false);
  assert.equal(blockedReverse.error.code, "application-origin");

  const lookalikeHost = validateBrowserAddress("http://localhost.evil.example:54685/", "http://127.0.0.1:54685");
  assert.equal(lookalikeHost.ok, true);

  const otherPort = validateBrowserAddress("http://localhost:9999/", "http://127.0.0.1:54685");
  assert.equal(otherPort.ok, true);

  assert.equal(sameLoopbackOrigin("http://[::1]:54685", "http://localhost:54685"), true);
  assert.equal(sameLoopbackOrigin("https://localhost:54685", "http://localhost:54685"), false);
});

test("registration creates the browser session on demand", (t) => {
  const agent = { id: SESSION_ID, ctx: { effect: () => () => {} } };
  const agents = new Map([[SESSION_ID, agent]]);
  const ctx = {
    webServer: { getOrigin: () => APPLICATION_ORIGIN },
    get(name) { return name === "agents" ? { get: (id) => agents.get(id) } : undefined; },
    on() { return () => {}; },
  };
  const host = new BrowserHost(ctx);
  t.after(() => host.dispose());

  assert.equal(host.sessions.size, 0);
  const registered = createResponse();
  host.registerClient(registrationRequest({ origin: null }), registered);
  assert.equal(registered.status, 200);
  assert.equal(typeof registered.body.capability, "string");
  assert.ok(host.sessions.get(SESSION_ID));
});

test("registration for a session without a live agent is rejected with diagnostics", (t) => {
  const { host } = createHost(t);

  const response = createResponse();
  host.registerClient({
    method: "POST",
    headers: {},
    url: `/dsh-agentic-browser/api/register?sessionId=agent-session-unknown&clientId=${CLIENT_ID}`,
  }, response);
  assert.equal(response.status, 404);
  assert.equal(response.body.error, "session-not-found");
  assert.equal(response.body.reason, "no-live-agent");
  assert.equal(response.body.sessionId, "agent-session-unknown");
});

test("agent disposal removes the browser session", (t) => {
  let disposedHandler;
  const agent = { id: SESSION_ID, ctx: { effect: () => () => {} } };
  const agents = new Map([[SESSION_ID, agent]]);
  const ctx = {
    webServer: { getOrigin: () => APPLICATION_ORIGIN },
    get(name) { return name === "agents" ? { get: (id) => agents.get(id) } : undefined; },
    on(name, handler) { if (name === "agent/disposed") disposedHandler = handler; return () => {}; },
  };
  const host = new BrowserHost(ctx);
  t.after(() => host.dispose());

  host.sessionFor(agent);
  assert.ok(host.sessions.get(SESSION_ID));
  disposedHandler({ agent });
  assert.equal(host.sessions.get(SESSION_ID), undefined);
});

test("registration returns a capability and refuses a competing Client", (t) => {
  const { host, session } = createHost(t);

  const registered = createResponse();
  host.registerClient(registrationRequest(), registered);
  assert.equal(registered.status, 200);
  assert.equal(typeof registered.body.capability, "string");
  assert.equal(registered.body.capability, session.capability);
  assert.equal(session.clientInstance, CLIENT_ID);

  const competing = createResponse();
  host.registerClient(registrationRequest({ clientId: OTHER_CLIENT_ID }), competing);
  assert.equal(competing.status, 409);
  assert.equal(session.clientInstance, CLIENT_ID);
});

test("disconnect requires the registered Client and its capability", async (t) => {
  const { host, session } = createHost(t);
  session.clientInstance = CLIENT_ID;

  const invalid = createResponse();
  await host.handleDisconnect(authenticatedRequest({ capability: "0".repeat(64) }), invalid);
  assert.equal(invalid.status, 401);
  assert.equal(session.clientInstance, CLIENT_ID);

  const competing = createResponse();
  await host.handleDisconnect(authenticatedRequest({ clientId: OTHER_CLIENT_ID, capability: session.capability }), competing);
  assert.equal(competing.status, 409);
  assert.equal(session.clientInstance, CLIENT_ID);

  const disconnected = createResponse();
  await host.handleDisconnect(authenticatedRequest({ capability: session.capability }), disconnected);
  assert.equal(disconnected.status, 200);
  assert.deepEqual(disconnected.body, { ok: true });
  assert.equal(session.clientInstance, null);
});

test("disconnect requeues an unsettled command for the replacement Client", async (t) => {
  const { session } = createHost(t);
  session.clientInstance = CLIENT_ID;
  session.lastClientPollAt = Date.now();

  const resultPromise = session.request("navigate", { tabId: "tab-1", url: "https://example.test/" });
  const delivered = session.takeCommand(CLIENT_ID);
  assert.equal(delivered?.kind, "navigate");
  assert.equal(session.pendingCommands.get(delivered.id)?.deliveryClient, CLIENT_ID);

  assert.equal(session.disconnectClient(CLIENT_ID), true);
  assert.equal(session.clientInstance, null);
  assert.equal(session.pendingCommands.get(delivered.id)?.deliveryClient, null);

  session.clientInstance = OTHER_CLIENT_ID;
  const redelivered = session.takeCommand(OTHER_CLIENT_ID);
  assert.deepEqual(redelivered, delivered);
  assert.equal(session.resolveCommand(delivered.id, { message: "done" }, CLIENT_ID), false);
  assert.equal(session.resolveCommand(delivered.id, { message: "done" }, OTHER_CLIENT_ID), true);
  assert.deepEqual(await resultPromise, { message: "done" });
});

test("same-origin polling may omit Origin while mismatched Origins remain rejected", (t) => {
  const { host, session } = createHost(t);
  session.clientInstance = CLIENT_ID;

  const request = authenticatedRequest({ origin: null, capability: session.capability });
  request.url = request.url.replace("/disconnect", "/poll");
  const pollResponse = createResponse();
  const pollAuth = host.requestSession(request, pollResponse);
  assert.equal(pollAuth?.session, session);
  assert.equal(pollAuth?.clientId, CLIENT_ID);

  const wrongOriginResponse = createResponse();
  const wrongOriginAuth = host.requestSession(authenticatedRequest({ origin: "https://attacker.example", capability: session.capability }), wrongOriginResponse, { requirePost: true });
  assert.equal(wrongOriginAuth, null);
  assert.equal(wrongOriginResponse.status, 403);
  assert.equal(session.clientInstance, CLIENT_ID);
});

test("authenticated routes reject clients not registered for the session", (t) => {
  const { host, session } = createHost(t);
  session.clientInstance = CLIENT_ID;

  const competingClientResponse = createResponse();
  const competingClientAuth = host.requestSession(authenticatedRequest({ clientId: OTHER_CLIENT_ID, capability: session.capability }), competingClientResponse, { requirePost: true });
  assert.equal(competingClientAuth, null);
  assert.equal(competingClientResponse.status, 409);
  assert.equal(session.clientInstance, CLIENT_ID);

  session.clientInstance = null;
  const absentRegistrationResponse = createResponse();
  const absentRegistrationAuth = host.requestSession(authenticatedRequest({ origin: null, capability: session.capability }), absentRegistrationResponse);
  assert.equal(absentRegistrationAuth, null);
  assert.equal(absentRegistrationResponse.status, 409);
  assert.equal(session.clientInstance, null);
});
