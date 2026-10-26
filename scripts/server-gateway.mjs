/** Two listeners, one application: LAN web UI and authenticated public API.
 * The Next backend is internal to the Compose network and owns all state.
 */
import { timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HOP_HEADERS = new Set([
	"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
	"te", "trailer", "transfer-encoding", "upgrade",
]);

function requiredKey(value) {
	if (typeof value !== "string" || !/^[\x21-\x7e]+$/.test(value)) {
		throw new Error("LH_SERVER_API_KEY must be a non-empty key without spaces or control characters.");
	}
	return value;
}

function origin(value) {
	let url;
	try { url = new URL(value); } catch { /* Use a fixed error; configuration may contain secrets. */ }
	if (!url || !["http:", "https:"].includes(url.protocol) || !url.hostname ||
		url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
		throw new Error("LH_UPSTREAM_URL must be an HTTP or HTTPS origin without credentials, path, query, or fragment.");
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

export function readGatewayConfiguration(env = process.env) {
	return {
		apiKey: requiredKey(env.LH_SERVER_API_KEY),
		upstreamUrl: origin(env.LH_UPSTREAM_URL ?? "http://learnharness:3000").origin,
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

function authorized(request, expected) {
	let count = 0;
	for (let index = 0; index < request.rawHeaders.length; index += 2) {
		if (request.rawHeaders[index].toLowerCase() === "authorization") count++;
	}
	if (count !== 1 || typeof request.headers.authorization !== "string") return false;
	const match = /^Bearer ([\x21-\x7e]+)$/i.exec(request.headers.authorization);
	if (!match) return false;
	const supplied = Buffer.from(match[1]);
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

export function createServerGateway({ apiKey, upstreamUrl = "http://learnharness:3000", webPort = 8080, apiPort = 8081, host = "0.0.0.0" }) {
	const expected = Buffer.from(requiredKey(apiKey));
	const upstream = origin(upstreamUrl);
	webPort = port(webPort, "LH_WEB_PORT", true);
	apiPort = port(apiPort, "LH_API_PORT", true);
	if (webPort !== 0 && webPort === apiPort) throw new Error("The web and API listeners must use different ports.");
	const transport = upstream.protocol === "https:" ? https : http;
	const agent = new transport.Agent({ keepAlive: true });

	function handler(apiOnly) {
		return (request, response) => {
			if (apiOnly && !publicAPIPath(request.url)) {
				reject(response, 404, "Only LearnHarness API routes are available on this port.");
				return;
			}
			if (apiOnly && !authorized(request, expected)) {
				reject(response, 401, "A valid LearnHarness server API key is required.");
				return;
			}
			const headers = headersWithoutHopByHop(request.headers);
			if (apiOnly) delete headers.authorization;
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
		};
	}

	function server(apiOnly) {
		const instance = http.createServer(handler(apiOnly));
		// LearnHarness uses SSE, not HTTP upgrades or CONNECT tunnels.
		for (const event of ["upgrade", "connect"]) {
			instance.on(event, (request, socket) => {
				const status = apiOnly && !authorized(request, expected) ? "401 Unauthorized" : "400 Bad Request";
				socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
			});
		}
		return instance;
	}

	const webServer = server(false);
	const apiServer = server(true);
	const close = async () => {
		agent.destroy();
		await Promise.all([webServer, apiServer].map((instance) => new Promise((resolve) => {
			instance.close(() => resolve());
			instance.closeAllConnections();
		})));
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

async function main() {
	const gateway = createServerGateway(readGatewayConfiguration());
	await gateway.start();
	console.log(`[server-gateway] Web listener ${gateway.webServer.address().port}; authenticated API listener ${gateway.apiServer.address().port}.`);
	for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void gateway.close(); });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
	main().catch(() => {
		// Do not log request headers, configured credentials, or upstream errors.
		console.error("[server-gateway] Startup failed. Set a valid LH_SERVER_API_KEY, upstream origin, and distinct web/API ports.");
		process.exitCode = 1;
	});
}
