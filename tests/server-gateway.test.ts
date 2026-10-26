import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, RequestListener, RequestOptions, Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { TestContext } from "node:test";

interface Gateway {
	webServer: Server;
	apiServer: Server;
	start(): Promise<void>;
	close(): Promise<void>;
}
const require = createRequire(import.meta.url);
const { createServerGateway, readGatewayConfiguration, publicAPIPath } = require("../scripts/server-gateway.mjs") as {
	createServerGateway(options: { apiKey: string; upstreamUrl: string; webPort: number; apiPort: number; host: string }): Gateway;
	readGatewayConfiguration(env: Record<string, string | undefined>): { apiKey: string; upstreamUrl: string; webPort: number; apiPort: number; host: string };
	publicAPIPath(target: string): boolean;
};
const KEY = "gateway-test-secret-not-a-provider-key";

async function fixture(t: TestContext, handler?: RequestListener) {
	const received: Array<{ path: string; method: string; headers: IncomingHttpHeaders; body: string }> = [];
	const upstream = createServer(handler ?? (async (request, response) => {
		let body = "";
		for await (const chunk of request) body += String(chunk);
		const record = { path: request.url!, method: request.method!, headers: request.headers, body };
		received.push(record);
		response.setHeader("Content-Type", "application/json");
		response.setHeader("Connection", "x-upstream-hop");
		response.setHeader("x-upstream-hop", "must-be-removed");
		response.end(JSON.stringify(record));
	}));
	await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
	const upstreamPort = (upstream.address() as AddressInfo).port;
	const gateway = createServerGateway({
		apiKey: KEY, upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
		webPort: 0, apiPort: 0, host: "127.0.0.1",
	});

	t.after(async () => {
		await gateway.close();
		await new Promise<void>((resolve) => {
			upstream.close(() => resolve());
			upstream.closeAllConnections();
		});
	});
	await gateway.start();
	return {
		gateway, received,
		webPort: (gateway.webServer.address() as AddressInfo).port,
		apiPort: (gateway.apiServer.address() as AddressInfo).port,
	};
}

function send(port: number, target: string, options: { method?: string; headers?: RequestOptions["headers"]; body?: string } = {}) {
	return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
		const request = httpRequest({
			hostname: "127.0.0.1", port, path: target, method: options.method ?? "GET",
			headers: options.headers, agent: false,
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

test("gateway configuration requires a key before either listener can start", () => {
	for (const value of [undefined, "", " ", "leading space", "key\nvalue"]) {
		assert.throws(() => readGatewayConfiguration({ LH_SERVER_API_KEY: value }), /LH_SERVER_API_KEY/);
	}
	const configuration = readGatewayConfiguration({ LH_SERVER_API_KEY: KEY, HOSTNAME: "unrelated-container-hostname" });
	assert.deepEqual(configuration, {
		apiKey: KEY, upstreamUrl: "http://learnharness:3000", webPort: 8080, apiPort: 8081, host: "0.0.0.0",
	});
	for (const value of ["file:///private/data", "http://name:secret@server", "http://server/path", "http://server?key=secret", "http://server/#secret"]) {
		assert.throws(() => readGatewayConfiguration({ LH_SERVER_API_KEY: KEY, LH_UPSTREAM_URL: value }), /LH_UPSTREAM_URL/);
	}
	for (const value of ["0", "-1", "65536", "8081suffix"]) {
		assert.throws(() => readGatewayConfiguration({ LH_SERVER_API_KEY: KEY, LH_API_PORT: value }), /LH_API_PORT/);
	}
});

test("LAN web pages and their same-origin APIs stay accessible without a key", async (t) => {
	const { webPort } = await fixture(t);
	for (const target of ["/", "/chat/session", "/_next/static/app.js", "/api/graph", "/api/events"]) {
		assert.equal((await send(webPort, target)).status, 200, target);
	}
});

test("public API authenticates every method and refuses cookie, query, malformed, or duplicate credentials", async (t) => {
	const { apiPort, received } = await fixture(t);
	for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
		for (const headers of [undefined, { Authorization: "Bearer wrong" }]) {
			const denied = await send(apiPort, "/api/graph", { method, headers });
			assert.equal(denied.status, 401, method);
			assert.equal(denied.headers["cache-control"], "no-store");
			assert.match(String(denied.headers["www-authenticate"]), /^Bearer /);
			assert(!denied.body.includes(KEY));
		}
		assert.equal((await send(apiPort, "/api/graph", { method, headers: { Authorization: `Bearer ${KEY}` } })).status, 200, method);
	}
	const before = received.length;
	for (const headers of [
		{ Cookie: `api_key=${KEY}` },
		{ Authorization: `Basic ${Buffer.from(KEY).toString("base64")}` },
		{ Authorization: `Bearer ${KEY}, Bearer ${KEY}` },
		["Authorization", `Bearer ${KEY}`, "Authorization", `Bearer ${KEY}`],
	]) {
		assert.equal((await send(apiPort, `/api/graph?api_key=${KEY}`, { headers })).status, 401);
	}
	assert.equal((await send(apiPort, `/api/graph?access_token=${KEY}`)).status, 401);
	assert.equal(received.length, before, "rejected credentials never reach the backend");
});

test("public API never forwards pages, RSC, path lookalikes, or traversal targets", async (t) => {
	const { apiPort, received } = await fixture(t);
	for (const target of [
		"/", "/chat/private?_rsc=private", "/_next/static/app.js", "/apix/graph", "/apiary", "//api/graph",
		"/api/../chat/private", "/api/./graph", "/api/a/../../chat/private", "/api//graph",
		"/api/%2e%2e/chat/private", "/api/%252e%252e/chat/private", "/api/a%2f..%2f..%2fchat/private",
		"/api/%5c..%5cchat/private", "/api\\..\\chat/private", "/api/%00/graph", "/api/%09/graph",
		"/api/%20/graph", "/api/%7f/graph", "/api/%23/graph", "/api/%zz/graph",
	]) {
		assert.equal(publicAPIPath(target), false, target);
		assert.equal((await send(apiPort, target, { headers: { Authorization: `Bearer ${KEY}` } })).status, 404, target);
	}
	assert.equal(received.length, 0);
	for (const target of ["/api", "/api/graph", "/api/chats/normal-id?query=..%2Fchat", "/api/settings/prompts/file.md"]) {
		assert.equal(publicAPIPath(target), true, target);
		assert.equal((await send(apiPort, target, { headers: { Authorization: `Bearer ${KEY}` } })).status, 200, target);
	}
});

test("API forwarding preserves body, path, query and status while stripping credentials and hop headers", async (t) => {
	const { apiPort, received } = await fixture(t);
	const body = JSON.stringify({ message: "hello" });
	const result = await send(apiPort, "/api/chat?mode=one%20two", {
		method: "POST", body,
		headers: {
			Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
			Connection: "x-request-hop", "x-request-hop": "must-be-removed", "Proxy-Authorization": "must-be-removed",
			"x-learnharness-desktop": "must-be-removed", "x-forwarded-for": "forged-client",
		},
	});
	assert.equal(result.status, 200);
	assert.equal(result.headers["x-upstream-hop"], undefined);
	assert.equal(received[0]!.path, "/api/chat?mode=one%20two");
	assert.equal(received[0]!.body, body);
	for (const name of ["authorization", "proxy-authorization", "x-request-hop", "x-learnharness-desktop"]) {
		assert.equal(received[0]!.headers[name], undefined, name);
	}
	assert.notEqual(received[0]!.headers["x-forwarded-for"], "forged-client");
	assert(!result.body.includes(KEY));
});

test("quiet SSE sends its headers before the upstream emits any frame", { timeout: 5000 }, async (t) => {
	const { apiPort } = await fixture(t, (_request, response) => {
		response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
		response.flushHeaders();
		// No body is emitted. The downstream handshake must still complete.
	});
	await new Promise<void>((resolve, reject) => {
		const request = httpRequest({
			hostname: "127.0.0.1", port: apiPort, path: "/api/events",
			headers: { Authorization: `Bearer ${KEY}` }, agent: false,
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

test("SSE reaches the client before completion and cancelling it closes the upstream stream", { timeout: 5000 }, async (t) => {
	let upstreamClosed!: () => void;
	const closed = new Promise<void>((resolve) => { upstreamClosed = resolve; });
	const { apiPort } = await fixture(t, (_request, response) => {
		response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
		response.flushHeaders();
		response.write("event: activity-changed\ndata: {}\n\n");
		response.once("close", upstreamClosed);
		// Deliberately leave the response open; a buffering proxy would hang.
	});
	await new Promise<void>((resolve, reject) => {
		const request = httpRequest({
			hostname: "127.0.0.1", port: apiPort, path: "/api/events",
			headers: { Authorization: `Bearer ${KEY}` }, agent: false,
		}, (response) => {
			assert.equal(response.statusCode, 200);
			assert.match(String(response.headers["content-type"]), /text\/event-stream/);
			let frame = "";
			response.on("data", (chunk) => {
				frame += String(chunk);
				if (frame.includes("\n\n")) {
					assert.match(frame, /activity-changed/);
					response.destroy();
					resolve();
				}
			});
			response.once("error", reject);
		});
		request.once("error", reject);
		request.end();
	});
	await closed;
});
