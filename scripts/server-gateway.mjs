/** LAN website and authenticated API routing. Multiuser deployments forward
 * to one authenticated worker per user; workers alone own application state.
 */
import { timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HOP_HEADERS = new Set([
	"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
	"te", "trailer", "transfer-encoding", "upgrade",
]);

function requiredKey(value, name = "LH_SERVER_API_KEY") {
	if (typeof value !== "string" || !/^[\x21-\x7e]+$/.test(value)) {
		throw new Error(`${name} must be a non-empty key without spaces or control characters.`);
	}
	return value;
}

function origin(value, name = "LH_UPSTREAM_URL") {
	let url;
	try { url = new URL(value); } catch { /* Use a fixed error; configuration may contain secrets. */ }
	if (!url || !["http:", "https:"].includes(url.protocol) || !url.hostname ||
		url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
		throw new Error(`${name} must be an HTTP or HTTPS origin without credentials, path, query, or fragment.`);
	}
	return url;
}

function port(value, name, allowEphemeral = false) {
	if (!/^\d+$/.test(String(value))) throw new Error(`${name} must be a valid port number.`);
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < (allowEphemeral ? 0 : 1) || number > 65535) {
		throw new Error(`${name} must be a valid port number.`);
	}
	return number;
}

function userRoutes(users) {
	if (!Array.isArray(users) || users.length === 0) throw new Error("LH_SERVER_USERS must be a non-empty array of users.");
	const ids = new Set();
	const keys = new Set();
	const upstreams = new Set();
	return users.map((user) => {
		if (!user || typeof user !== "object" || Array.isArray(user) ||
			Object.keys(user).some((name) => !["id", "apiKey", "upstreamUrl"].includes(name)) ||
			typeof user.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(user.id)) {
			throw new Error("LH_SERVER_USERS entries require a valid id, apiKey, and upstreamUrl.");
		}
		const apiKey = requiredKey(user.apiKey, "LH_SERVER_USERS apiKey");
		const upstreamUrl = origin(user.upstreamUrl, "LH_SERVER_USERS upstreamUrl").origin;
		if (ids.has(user.id) || keys.has(apiKey) || upstreams.has(upstreamUrl)) {
			throw new Error("LH_SERVER_USERS must use distinct user ids, API keys, and upstream origins.");
		}
		ids.add(user.id);
		keys.add(apiKey);
		upstreams.add(upstreamUrl);
		return { id: user.id, apiKey, upstreamUrl };
	});
}

function selectedWebKey(users, value) {
	const key = requiredKey(value, "LH_WEB_API_KEY");
	if (!users.some((user) => user.apiKey === key)) throw new Error("LH_WEB_API_KEY must match a configured user API key.");
	return key;
}

export function readGatewayConfiguration(env = process.env) {
	let routing;
	if (env.LH_SERVER_USERS !== undefined) {
		if (env.LH_SERVER_API_KEY !== undefined || env.LH_UPSTREAM_URL !== undefined) {
			throw new Error("LH_SERVER_USERS cannot be combined with LH_SERVER_API_KEY or LH_UPSTREAM_URL.");
		}
		let parsed;
		try { parsed = JSON.parse(env.LH_SERVER_USERS); } catch { throw new Error("LH_SERVER_USERS must contain valid JSON."); }
		const users = userRoutes(parsed);
		routing = { users, webApiKey: selectedWebKey(users, env.LH_WEB_API_KEY) };
	} else {
		if (env.LH_WEB_API_KEY !== undefined) throw new Error("LH_WEB_API_KEY requires LH_SERVER_USERS.");
		routing = {
			apiKey: requiredKey(env.LH_SERVER_API_KEY),
			upstreamUrl: origin(env.LH_UPSTREAM_URL ?? "http://127.0.0.1:3000").origin,
		};
	}
	return {
		...routing,
		webPort: port(env.LH_WEB_PORT ?? "8080", "LH_WEB_PORT"),
		apiPort: port(env.LH_API_PORT ?? "8081", "LH_API_PORT"),
		host: "0.0.0.0",
	};
}

/** Validate the raw request target before forwarding it unchanged. Reject
 * ambiguous encodings so Next cannot reinterpret an API path as an SSR page.
 * Query parameters remain untouched; only the path determines the boundary.
 */
export function publicAPIPath(target) {
	if (typeof target !== "string" || !target.startsWith("/") || target.startsWith("//")) return false;
	const pathname = target.split("?", 1)[0];
	if (/[\\\x00-\x20\x7f#]/.test(pathname) || /%(?:2e|2f|5c|25)/i.test(pathname)) return false;
	let decoded;
	try { decoded = decodeURIComponent(pathname); } catch { return false; }
	if (/[\\\x00-\x20\x7f#]/.test(decoded) || decoded.includes("//") ||
		decoded.split("/").some((segment) => segment === "." || segment === "..")) return false;
	return pathname === "/api" || pathname.startsWith("/api/");
}

function bearerKey(request) {
	let count = 0;
	for (let index = 0; index < request.rawHeaders.length; index += 2) {
		if (request.rawHeaders[index].toLowerCase() === "authorization") count++;
	}
	if (count !== 1 || typeof request.headers.authorization !== "string") return undefined;
	const match = /^Bearer ([\x21-\x7e]+)$/i.exec(request.headers.authorization);
	return match ? Buffer.from(match[1]) : undefined;
}

function keyMatches(supplied, expected) {
	if (!supplied) return false;
	return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function headersWithoutHopByHop(headers) {
	const omitted = new Set(HOP_HEADERS);
	for (const name of String(headers.connection ?? "").split(",")) omitted.add(name.trim().toLowerCase());
	return Object.fromEntries(Object.entries(headers).filter(([name, value]) => value !== undefined && !omitted.has(name.toLowerCase())));
}

function reject(response, status, error) {
	if (response.destroyed) return;
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		...(status === 401 ? { "WWW-Authenticate": 'Bearer realm="LearnHarness API"' } : {}),
	});
	response.end(JSON.stringify({ error }));
}

function listen(server, listenPort, host) {
	return new Promise((resolve, reject) => {
		const failed = (error) => { server.off("listening", ready); reject(error); };
		const ready = () => { server.off("error", failed); resolve(); };
		server.once("error", failed);
		server.once("listening", ready);
		server.listen(listenPort, host);
	});
}

/** A single forwarding hop. Credentials are removed before reaching a raw
 * backend; only the central router supplies a worker credential explicitly.
 */
function forwardingTarget(upstreamUrl, apiKey) {
	const upstream = origin(upstreamUrl);
	const transport = upstream.protocol === "https:" ? https : http;
	const agent = new transport.Agent({ keepAlive: true });
	return {
		destroy() { agent.destroy(); },
		forward(request, response) {
			const headers = headersWithoutHopByHop(request.headers);
			delete headers.authorization;
			if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;
			// Neither listener can lend the packaged desktop's private capability.
			delete headers["x-learnharness-desktop"];
			delete headers.forwarded;
			delete headers["x-forwarded-for"];
			delete headers["x-forwarded-host"];
			delete headers["x-forwarded-proto"];
			headers.host = request.headers.host ?? upstream.host;
			headers["x-forwarded-host"] = headers.host;
			headers["x-forwarded-for"] = request.socket.remoteAddress ?? "";
			headers["x-forwarded-proto"] = "http";

			let upstreamRequest;
			let upstreamResponse;
			const unavailable = () => {
				if (response.headersSent) response.destroy();
				else reject(response, 502, "The LearnHarness server is unavailable.");
			};
			try {
				upstreamRequest = transport.request(upstream, {
					method: request.method, path: request.url, headers, agent,
				}, (incoming) => {
					if (response.destroyed) { incoming.destroy(); return; }
					upstreamResponse = incoming;
					incoming.once("error", unavailable);
					incoming.once("aborted", () => response.destroy());
					response.writeHead(incoming.statusCode ?? 502, headersWithoutHopByHop(incoming.headers));
					// /api/events can remain quiet until its 25s heartbeat. Send
					// its handshake now so clients can finish attaching immediately.
					response.flushHeaders();
					// pipe supplies backpressure; SSE has no buffer or idle timeout.
					incoming.pipe(response);
				});
			} catch {
				reject(response, 400, "Invalid request target.");
				return;
			}
			upstreamRequest.once("error", unavailable);
			request.once("aborted", () => upstreamRequest.destroy());
			request.once("error", () => upstreamRequest.destroy());
			response.once("close", () => {
				if (!response.writableFinished) {
					upstreamRequest.destroy();
					upstreamResponse?.destroy();
				}
			});
			request.pipe(upstreamRequest);
		},
	};
}

function rejectTunnels(server, authorized) {
	// LearnHarness uses SSE, not HTTP upgrades or CONNECT tunnels.
	for (const event of ["upgrade", "connect"]) {
		server.on(event, (request, socket) => {
			const status = authorized(request) ? "400 Bad Request" : "401 Unauthorized";
			socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
		});
	}
}

function closeServers(servers) {
	return Promise.all(servers.map((server) => new Promise((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections();
	})));
}

export function createServerGateway(options) {
	const { webPort: requestedWebPort = 8080, apiPort: requestedApiPort = 8081, host = "0.0.0.0" } = options;
	const webPort = port(requestedWebPort, "LH_WEB_PORT", true);
	const apiPort = port(requestedApiPort, "LH_API_PORT", true);
	if (webPort !== 0 && webPort === apiPort) throw new Error("The web and API listeners must use different ports.");
	const multiuser = options.users !== undefined;
	if (multiuser && (options.apiKey !== undefined || options.upstreamUrl !== undefined)) {
		throw new Error("Multiuser and single-user gateway routing cannot be combined.");
	}
	if (!multiuser && options.webApiKey !== undefined) throw new Error("webApiKey requires users.");
	const users = multiuser ? userRoutes(options.users) : [{
		apiKey: requiredKey(options.apiKey),
		upstreamUrl: origin(options.upstreamUrl ?? "http://127.0.0.1:3000").origin,
	}];
	const webKey = multiuser ? selectedWebKey(users, options.webApiKey) : users[0].apiKey;
	const targets = users.map((user) => ({
		expected: Buffer.from(user.apiKey),
		target: forwardingTarget(user.upstreamUrl, multiuser ? user.apiKey : undefined),
	}));
	const webTarget = targets[users.findIndex((user) => user.apiKey === webKey)].target;
	const authenticatedTarget = (request) => {
		const supplied = bearerKey(request);
		return targets.find(({ expected }) => keyMatches(supplied, expected))?.target;
	};
	const webServer = http.createServer((request, response) => webTarget.forward(request, response));
	const apiServer = http.createServer((request, response) => {
		if (!publicAPIPath(request.url)) {
			reject(response, 404, "Only LearnHarness API routes are available on this port.");
			return;
		}
		const target = authenticatedTarget(request);
		if (!target) {
			reject(response, 401, "A valid LearnHarness server API key is required.");
			return;
		}
		target.forward(request, response);
	});
	rejectTunnels(webServer, () => true);
	rejectTunnels(apiServer, authenticatedTarget);
	const close = async () => {
		for (const { target } of targets) target.destroy();
		await closeServers([webServer, apiServer]);
	};
	return {
		webServer, apiServer,
		async start() {
			try {
				await listen(webServer, webPort, host);
				await listen(apiServer, apiPort, host);
			} catch (error) {
				await close();
				throw error;
			}
		},
		close,
	};
}

/** The only network listener in a user container. Unlike the public API
 * listener, authenticated pages/assets are allowed for the selected website.
 * The raw Next server stays on loopback and never receives the access key.
 */
export function createWorkerGateway({ apiKey, upstreamUrl = "http://127.0.0.1:3000", port: requestedPort = 8081, host = "0.0.0.0" }) {
	const expected = Buffer.from(requiredKey(apiKey));
	const workerPort = port(requestedPort, "LH_API_PORT", true);
	const target = forwardingTarget(upstreamUrl);
	const authorized = (request) => keyMatches(bearerKey(request), expected);
	const server = http.createServer((request, response) => {
		if (!authorized(request)) {
			reject(response, 401, "A valid LearnHarness server API key is required.");
			return;
		}
		target.forward(request, response);
	});
	rejectTunnels(server, authorized);
	const close = async () => {
		target.destroy();
		await closeServers([server]);
	};
	return {
		server,
		async start() {
			try { await listen(server, workerPort, host); }
			catch (error) { await close(); throw error; }
		},
		close,
	};
}

async function main() {
	const gateway = createServerGateway(readGatewayConfiguration());
	await gateway.start();
	console.log(`[server-gateway] Web listener ${gateway.webServer.address().port}; authenticated API listener ${gateway.apiServer.address().port}.`);
	for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void gateway.close(); });
}

if (process.argv[1] && existsSync(process.argv[1]) && pathToFileURL(realpathSync(path.resolve(process.argv[1]))).href === import.meta.url) {
	main().catch(() => {
		// Do not log request headers, configured credentials, or upstream errors.
		console.error("[server-gateway] Startup failed. Check user/key routing, web-user selection, upstream origins, and distinct web/API ports.");
		process.exitCode = 1;
	});
}
