import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, RequestOptions, Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { TestContext } from "node:test";

interface User {
	id: string;
	apiKey: string;
	upstreamUrl: string;
}
interface Router {
	webServer: Server;
	apiServer: Server;
	start(): Promise<void>;
	close(): Promise<void>;
}
interface Worker {
	server: Server;
	start(): Promise<void>;
	close(): Promise<void>;
}
const require = createRequire(import.meta.url);
const { createServerGateway, createWorkerGateway, readGatewayConfiguration } = require("../scripts/server-gateway.mjs") as {
	createServerGateway(options: { users: User[]; webApiKey: string; webPort: number; apiPort: number; host: string }): Router;
	createWorkerGateway(options: { apiKey: string; upstreamUrl: string; port: number; host: string }): Worker;
	readGatewayConfiguration(env: Record<string, string | undefined>): {
		users: User[]; webApiKey: string; webPort: number; apiPort: number; host: string;
	};
};
const { readContainerConfiguration } = require("../scripts/start-container.mjs") as {
	readContainerConfiguration(env: Record<string, string | undefined>): {
		mode: "single" | "worker";
		backendPort: number;
		configuration: { apiKey: string; upstreamUrl: string; apiPort: number; webPort: number; host: string };
	};
};
const PRIMARY_KEY = "multiuser-primary-test-server-secret";
const SECONDARY_KEY = "multiuser-secondary-test-server-secret";
const HOST = "127.0.0.1";

function serverPort(server: Server): number {
	return (server.address() as AddressInfo).port;
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections();
	});
}

function send(port: number, target: string, options: { method?: string; headers?: RequestOptions["headers"]; body?: string } = {}) {
	return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
		const request = httpRequest({
			hostname: HOST, port, path: target, method: options.method ?? "GET", headers: options.headers, agent: false,
		}, (response) => {
			let body = "";
			response.on("data", (chunk) => { body += String(chunk); });
			response.once("error", reject);
			response.once("end", () => resolve({ status: response.statusCode!, headers: response.headers, body }));
		});
		request.once("error", reject);
		request.end(options.body);
	});
}

function bearer(apiKey: string) {
	return { Authorization: `Bearer ${apiKey}` };
}

async function fixture(t: TestContext, webApiKey = PRIMARY_KEY) {
	const applications = await Promise.all([
		{ id: "primary", apiKey: PRIMARY_KEY },
		{ id: "secondary", apiKey: SECONDARY_KEY },
	].map(async ({ id, apiKey }) => {
		const received: Array<{ path: string; headers: IncomingHttpHeaders; body: string }> = [];
		const sessions = new Map<string, string>();
		const streamClosures = new Set<() => void>();
		const app = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += String(chunk);
			received.push({ path: request.url!, headers: request.headers, body });
			const pathname = new URL(request.url!, "http://application").pathname;
			if (pathname === "/api/events" || pathname === "/api/events/quiet") {
				response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
				response.flushHeaders();
				if (pathname === "/api/events") response.write(`event: user\ndata: ${JSON.stringify({ owner: id })}\n\n`);
				response.once("close", () => {
					for (const notify of streamClosures) notify();
				});
				return;
			}
			response.setHeader("Content-Type", "application/json");
			if (pathname === "/api/chats" && request.method === "POST") {
				const record = JSON.parse(body) as { id: string; title: string };
				sessions.set(record.id, record.title);
				response.end(JSON.stringify({ id: record.id, owner: id }));
				return;
			}
			if (pathname === "/api/chats") {
				response.end(JSON.stringify({ owner: id, chats: [...sessions].map(([sessionId, title]) => ({ id: sessionId, title })) }));
				return;
			}
			if (pathname.startsWith("/api/chats/")) {
				const sessionId = pathname.slice("/api/chats/".length);
				if (!sessions.has(sessionId)) {
					response.writeHead(404);
					response.end(JSON.stringify({ error: "Session not found" }));
					return;
				}
				if (request.method === "DELETE") sessions.delete(sessionId);
				response.end(JSON.stringify({ owner: id, id: sessionId, title: sessions.get(sessionId) }));
				return;
			}
			response.end(JSON.stringify({ owner: id, headers: request.headers, body }));
		});
		await new Promise<void>((resolve) => app.listen(0, HOST, resolve));
		t.after(() => closeServer(app));
		const worker = createWorkerGateway({ apiKey, upstreamUrl: `http://${HOST}:${serverPort(app)}`, port: 0, host: HOST });
		t.after(() => worker.close());
		await worker.start();
		return { id, apiKey, app, worker, received, sessions, streamClosures, upstreamUrl: `http://${HOST}:${serverPort(worker.server)}` };
	}));
	const users = applications.map(({ id, apiKey, upstreamUrl }) => ({ id, apiKey, upstreamUrl }));
	const routers: Router[] = [];
	t.after(async () => { await Promise.all(routers.map((router) => router.close())); });
	async function routerFor(nextUsers = users, selectedKey = webApiKey) {
		const router = createServerGateway({ users: nextUsers, webApiKey: selectedKey, webPort: 0, apiPort: 0, host: HOST });
		routers.push(router);
		await router.start();
		return { router, apiPort: serverPort(router.apiServer), webPort: serverPort(router.webServer) };
	}
	const [primary, secondary] = applications;
	assert.ok(primary);
	assert.ok(secondary);
	return { applications: [primary, secondary] as const, users, routerFor, ...await routerFor() };
}

test("multiuser configuration selects a configured web key and keeps stable user IDs", () => {
	const users = [
		{ id: "primary", apiKey: PRIMARY_KEY, upstreamUrl: "http://primary:8081" },
		{ id: "secondary", apiKey: SECONDARY_KEY, upstreamUrl: "http://secondary:8081" },
	];
	assert.deepEqual(readGatewayConfiguration({ LH_SERVER_USERS: JSON.stringify(users), LH_WEB_API_KEY: SECONDARY_KEY }), {
		users, webApiKey: SECONDARY_KEY, webPort: 8080, apiPort: 8081, host: "0.0.0.0",
	});
});

test("multiuser configuration rejects ambiguous users, keys, upstreams and web selections without exposing secrets", () => {
	const primary = { id: "primary", apiKey: PRIMARY_KEY, upstreamUrl: "http://primary:8081" };
	const secondary = { id: "secondary", apiKey: SECONDARY_KEY, upstreamUrl: "http://secondary:8081" };
	const invalidUsers: unknown[] = [
		[], {}, null, [primary, { ...secondary, id: primary.id }],
		[primary, { ...secondary, apiKey: PRIMARY_KEY }],
		[primary, { ...secondary, upstreamUrl: primary.upstreamUrl }],
		[{ ...primary, id: "" }], [{ ...primary, apiKey: "" }],
		[{ ...primary, apiKey: "key with spaces" }], [{ ...primary, upstreamUrl: "http://name:secret@worker" }],
		[{ ...primary, upstreamUrl: "http://primary:8081/api" }], [primary, null],
	];
	const invalidEnvironments = [
		...invalidUsers.map((users) => ({ LH_SERVER_USERS: JSON.stringify(users), LH_WEB_API_KEY: PRIMARY_KEY })),
		{ LH_SERVER_USERS: `invalid-json-${PRIMARY_KEY}`, LH_WEB_API_KEY: PRIMARY_KEY },
		{ LH_SERVER_USERS: JSON.stringify([primary]) },
		{ LH_SERVER_USERS: JSON.stringify([primary]), LH_WEB_API_KEY: SECONDARY_KEY },
		{ LH_SERVER_USERS: JSON.stringify([primary]), LH_WEB_API_KEY: PRIMARY_KEY, LH_SERVER_API_KEY: PRIMARY_KEY },
		{ LH_SERVER_USERS: JSON.stringify([primary]), LH_WEB_API_KEY: PRIMARY_KEY, LH_UPSTREAM_URL: "http://elsewhere:3000" },
	];
	for (const env of invalidEnvironments) {
		assert.throws(() => readGatewayConfiguration(env), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert(!error.message.includes(PRIMARY_KEY));
			assert(!error.message.includes(SECONDARY_KEY));
			return true;
		});
	}
});

test("worker launcher keeps the application on loopback and refuses shared routing credentials", () => {
	const env = { LH_CONTAINER_MODE: "worker", LH_SERVER_API_KEY: PRIMARY_KEY };
	const result = readContainerConfiguration({ ...env, PORT: "3010", LH_API_PORT: "8082", LH_UPSTREAM_URL: "http://another-user:3000" });
	assert.equal(result.mode, "worker");
	assert.equal(result.backendPort, 3010);
	assert.equal(result.configuration.upstreamUrl, "http://127.0.0.1:3010");
	assert.equal(result.configuration.apiKey, PRIMARY_KEY);
	assert.equal(result.configuration.apiPort, 8082);
	for (const overrides of [
		{ LH_SERVER_USERS: "[]" }, { LH_SERVER_USERS: "" }, { LH_WEB_API_KEY: SECONDARY_KEY },
		{ LH_CONTAINER_MODE: "router" }, { LH_API_PORT: "3000" }, { PORT: "0" }, { PORT: "3000invalid" },
	]) {
		assert.throws(() => readContainerConfiguration({ ...env, ...overrides }));
	}
	assert.equal(readContainerConfiguration({ LH_SERVER_API_KEY: PRIMARY_KEY }).mode, "single", "existing deployments keep their default mode");
});

test("API users read and write only their backend even when session IDs match", async (t) => {
	const { apiPort, applications } = await fixture(t);
	for (const [key, title] of [[PRIMARY_KEY, "Primary history"], [SECONDARY_KEY, "Secondary history"]] as const) {
		const body = JSON.stringify({ id: "same-session", title });
		assert.equal((await send(apiPort, "/api/chats", { method: "POST", headers: { ...bearer(key), "Content-Type": "application/json" }, body })).status, 200);
	}
	for (const [key, title, owner] of [[PRIMARY_KEY, "Primary history", "primary"], [SECONDARY_KEY, "Secondary history", "secondary"]] as const) {
		const result = await send(apiPort, "/api/chats/same-session", { headers: bearer(key) });
		assert.equal(result.status, 200);
		assert.deepEqual(JSON.parse(result.body), { owner, id: "same-session", title });
	}
	assert.equal(applications[0].sessions.get("same-session"), "Primary history");
	assert.equal(applications[1].sessions.get("same-session"), "Secondary history");
});

test("knowing another user's session ID cannot read or delete that session", async (t) => {
	const { apiPort, applications } = await fixture(t);
	applications[0].sessions.set("primary-only", "Private primary history");
	for (const method of ["GET", "DELETE"]) {
		const result = await send(apiPort, "/api/chats/primary-only?user=primary&api_key=" + PRIMARY_KEY, {
			method, headers: { ...bearer(SECONDARY_KEY), Cookie: `api_key=${PRIMARY_KEY}`, "x-user-id": "primary" },
		});
		assert.equal(result.status, 404);
		assert(!result.body.includes("Private primary history"));
	}
	assert.equal(applications[0].sessions.get("primary-only"), "Private primary history");
	assert.equal(applications[0].received.length, 0, "forged ownership metadata never selects the other backend");
});

test("the web interface remains pinned to its configured user for pages, assets and APIs", async (t) => {
	const { webPort, applications } = await fixture(t, SECONDARY_KEY);
	for (const target of ["/", "/chat/same-session", "/_next/static/test.js", "/api/settings"]) {
		const response = await send(webPort, target + "?api_key=" + PRIMARY_KEY, {
			headers: { ...bearer(PRIMARY_KEY), Cookie: `api_key=${PRIMARY_KEY}`, "x-user-id": "primary" },
		});
		assert.equal(response.status, 200);
		assert.equal(JSON.parse(response.body).owner, "secondary");
		assert(!response.body.includes(SECONDARY_KEY), "the configured web credential never reaches the app or browser");
	}
	assert.equal(applications[0].received.length, 0);
	assert.equal(applications[1].received.length, 4);
	const body = JSON.stringify({ id: "web-session", title: "Created through the website" });
	assert.equal((await send(webPort, "/api/chats", { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 200);
	assert.equal(applications[1].sessions.get("web-session"), "Created through the website");
	assert.equal(applications[0].sessions.has("web-session"), false);
});

test("worker listeners require their own key on every path and strip transport credentials before the app", async (t) => {
	const { applications } = await fixture(t);
	const primary = applications[0];
	const port = serverPort(primary.worker.server);
	for (const path of ["/", "/_next/static/test.js", "/api/chats", "/api/events"]) {
		for (const headers of [undefined, bearer(SECONDARY_KEY)]) {
			assert.equal((await send(port, path, { headers })).status, 401, path);
		}
	}
	assert.equal(primary.received.length, 0);
	const response = await send(port, "/api/settings", {
		headers: {
			...bearer(PRIMARY_KEY), "x-learnharness-desktop": "forged-capability", Forwarded: "forged",
			"x-forwarded-for": "forged-client", "x-forwarded-host": "forged-host", "x-forwarded-proto": "https",
		},
	});
	assert.equal(response.status, 200);
	const headers = primary.received[0]!.headers;
	assert.equal(headers.authorization, undefined);
	assert.equal(headers["x-learnharness-desktop"], undefined);
	assert.equal(headers.forwarded, undefined);
	assert.notEqual(headers["x-forwarded-for"], "forged-client");
	assert.notEqual(headers["x-forwarded-host"], "forged-host");
	assert(!response.body.includes(PRIMARY_KEY));
});

test("multiuser API rejects missing and malformed authentication and preserves its API-only boundary", async (t) => {
	const { apiPort, applications } = await fixture(t);
	for (const headers of [
		undefined, bearer("unknown-key"), { Cookie: `api_key=${PRIMARY_KEY}` },
		{ Authorization: `Bearer ${PRIMARY_KEY}, Bearer ${SECONDARY_KEY}` },
		["Host", `${HOST}:${apiPort}`, "Authorization", `Bearer ${PRIMARY_KEY}`, "Authorization", `Bearer ${SECONDARY_KEY}`],
	]) {
		assert.equal((await send(apiPort, "/api/chats?api_key=" + PRIMARY_KEY, { headers })).status, 401);
	}
	for (const path of ["/", "/chat/private", "/_next/static/test.js", "/api/../chat/private", "/api/%2e%2e/chat/private"]) {
		assert.equal((await send(apiPort, path, { headers: bearer(PRIMARY_KEY) })).status, 404);
	}
	assert.equal(applications[0].received.length, 0);
	assert.equal(applications[1].received.length, 0);
});

test("an unavailable user's backend fails without falling back to the web user", async (t) => {
	const { apiPort, applications } = await fixture(t);
	applications[0].sessions.set("primary-only", "Must never fall back here");
	await applications[1].worker.close();
	const response = await send(apiPort, "/api/chats", { headers: bearer(SECONDARY_KEY) });
	assert.equal(response.status, 502);
	assert(!response.body.includes("Must never fall back here"));
	assert(!response.body.includes(SECONDARY_KEY));
	assert.equal(applications[0].received.length, 0);
	assert.equal((await send(apiPort, "/api/chats", { headers: bearer(PRIMARY_KEY) })).status, 200);
});

test("rotating a user's key preserves the same backend history and rejects the old key", async (t) => {
	const { applications, users, routerFor } = await fixture(t);
	applications[0].sessions.set("existing-history", "Persisted before key rotation");
	const rotatedKey = "rotated-primary-test-server-secret";
	const rotatedWorker = createWorkerGateway({
		apiKey: rotatedKey, upstreamUrl: `http://${HOST}:${serverPort(applications[0].app)}`, port: 0, host: HOST,
	});
	t.after(() => rotatedWorker.close());
	await rotatedWorker.start();
	const rotatedUsers = users.map((user) => user.id === "primary"
		? { ...user, apiKey: rotatedKey, upstreamUrl: `http://${HOST}:${serverPort(rotatedWorker.server)}` }
		: user);
	const { apiPort, webPort } = await routerFor(rotatedUsers, rotatedKey);
	assert.equal((await send(apiPort, "/api/chats/existing-history", { headers: bearer(PRIMARY_KEY) })).status, 401);
	const retained = await send(apiPort, "/api/chats/existing-history", { headers: bearer(rotatedKey) });
	assert.equal(retained.status, 200);
	assert.equal(JSON.parse(retained.body).title, "Persisted before key rotation");
	assert.equal((await send(apiPort, "/api/chats/existing-history", { headers: bearer(SECONDARY_KEY) })).status, 404);
	assert.equal((await send(webPort, "/api/chats/existing-history")).status, 200);
});

for (const listener of ["api", "web"] as const) {
	test(`${listener} quiet SSE sends its handshake through both proxy hops before any frame`, { timeout: 5000 }, async (t) => {
		const { apiPort, webPort } = await fixture(t);
		await new Promise<void>((resolve, reject) => {
			const request = httpRequest({
				hostname: HOST, port: listener === "api" ? apiPort : webPort, path: "/api/events/quiet",
				headers: listener === "api" ? bearer(PRIMARY_KEY) : undefined, agent: false,
			}, (response) => {
				assert.equal(response.statusCode, 200);
				assert.match(String(response.headers["content-type"]), /text\/event-stream/);
				response.destroy();
				resolve();
			});
			request.once("error", reject);
			request.end();
		});
	});

	test(`${listener} SSE streams from only the selected user and cancellation closes both proxy hops`, { timeout: 5000 }, async (t) => {
		const { apiPort, webPort, applications } = await fixture(t, SECONDARY_KEY);
		let streamClosed!: () => void;
		const closed = new Promise<void>((resolve) => { streamClosed = resolve; });
		applications[1].streamClosures.add(streamClosed);
		await new Promise<void>((resolve, reject) => {
			const request = httpRequest({
				hostname: HOST, port: listener === "api" ? apiPort : webPort, path: "/api/events",
				headers: listener === "api" ? bearer(SECONDARY_KEY) : undefined, agent: false,
			}, (response) => {
				assert.equal(response.statusCode, 200);
				assert.match(String(response.headers["content-type"]), /text\/event-stream/);
				let frame = "";
				response.on("data", (chunk) => {
					frame += String(chunk);
					if (!frame.includes("\n\n")) return;
					assert.equal(frame, 'event: user\ndata: {"owner":"secondary"}\n\n');
					response.destroy();
					resolve();
				});
				response.once("error", reject);
			});
			request.once("error", reject);
			request.end();
		});
		await closed;
		assert.equal(applications[0].received.length, 0);
		assert.equal(applications[1].received.length, 1);
	});
}
