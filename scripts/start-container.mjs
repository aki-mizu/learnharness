/** Run a private Next backend with either legacy web/API listeners or one
 * authenticated worker listener for a multiuser deployment.
 */
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { createServerGateway, createWorkerGateway, readGatewayConfiguration } from "./server-gateway.mjs";

const STARTUP_TIMEOUT_MS = 60_000;
// Leave time for cleanup before Compose's 60-second stop grace period expires.
const SHUTDOWN_TIMEOUT_MS = 50_000;

async function waitForBackend(upstreamUrl, signal) {
	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (!signal.aborted && Date.now() < deadline) {
		try {
			const response = await fetch(`${upstreamUrl}/api/graph`, {
				redirect: "error",
				signal: AbortSignal.any([
					signal,
					AbortSignal.timeout(Math.min(5000, deadline - Date.now())),
				]),
			});
			await response.body?.cancel();
			if (response.ok) return;
		} catch {
			if (signal.aborted) throw signal.reason;
		}
		await delay(250, undefined, { signal });
	}
	throw new Error("The LearnHarness backend did not become ready.");
}

export function readContainerConfiguration(env = process.env) {
	const mode = env.LH_CONTAINER_MODE ?? "single";
	if (!["single", "worker"].includes(mode)) throw new Error("LH_CONTAINER_MODE must be single or worker.");
	if (env.LH_SERVER_USERS !== undefined || env.LH_WEB_API_KEY !== undefined) {
		throw new Error("User containers must receive only their own LH_SERVER_API_KEY; run shared routing with server-gateway.mjs.");
	}
	const value = env.PORT ?? "3000";
	const backendPort = Number(value);
	if (!/^\d+$/.test(value) || !Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65535) {
		throw new Error("PORT must be a valid backend port number.");
	}
	const configuration = readGatewayConfiguration({
		...env,
		LH_UPSTREAM_URL: `http://127.0.0.1:${backendPort}`,
	});
	const listenerPorts = mode === "worker" ? [configuration.apiPort] : [configuration.webPort, configuration.apiPort];
	if (listenerPorts.includes(backendPort)) {
		throw new Error("The backend, website, and API must use different container ports.");
	}
	return { mode, backendPort, configuration };
}

async function main() {
	const { mode, backendPort, configuration } = readContainerConfiguration();
	// Validate all configuration before spawning a backend. Worker mode creates
	// no unauthenticated listener, including on the container's web port.
	const gateway = mode === "worker"
		? createWorkerGateway({ apiKey: configuration.apiKey, upstreamUrl: configuration.upstreamUrl, port: configuration.apiPort, host: configuration.host })
		: createServerGateway(configuration);
	const startup = new AbortController();
	let finishStartup;
	const startupFinished = new Promise((resolve) => { finishStartup = resolve; });
	let stopping = false;
	let backendExited = false;
	let shutdown;

	const backendEnv = { ...process.env, HOSTNAME: "127.0.0.1", PORT: String(backendPort) };
	// Only the gateway needs the public API credential.
	delete backendEnv.LH_SERVER_API_KEY;
	delete backendEnv.LH_CONTAINER_MODE;
	const backend = spawn(process.execPath, [path.join(import.meta.dirname, "server.js")], {
		cwd: import.meta.dirname,
		env: backendEnv,
		stdio: "inherit",
	});
	const backendFinished = new Promise((resolve) => {
		backend.once("error", () => {
			backendExited = true;
			resolve();
			fail("The backend could not start.");
		});
		backend.once("exit", () => {
			backendExited = true;
			resolve();
			if (!stopping) fail("The backend exited unexpectedly.");
		});
	});

	function stop(exitCode, signal = "SIGTERM") {
		if (stopping) return shutdown;
		stopping = true;
		process.exitCode = exitCode;
		startup.abort();
		if (!backendExited) backend.kill(signal);
		const force = setTimeout(() => {
			if (!backendExited) {
				console.error("[start-container] Backend shutdown timed out; stopping it forcibly.");
				process.exitCode = 1;
				backend.kill("SIGKILL");
			}
		}, SHUTDOWN_TIMEOUT_MS);
		force.unref();
		shutdown = (async () => {
			// A signal can arrive between the two listen calls. Let startup
			// settle before closing so neither listener can reopen afterward.
			await startupFinished;
			await Promise.all([gateway.close(), backendFinished]);
		})().finally(() => clearTimeout(force));
		return shutdown;
	}

	function fail(message) {
		if (stopping) return;
		console.error(`[start-container] ${message}`);
		void stop(1);
	}

	for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { void stop(0, signal); });
	for (const server of mode === "worker" ? [gateway.server] : [gateway.webServer, gateway.apiServer]) {
		server.on("error", () => fail("A gateway listener failed."));
	}
	try {
		await waitForBackend(configuration.upstreamUrl, startup.signal);
		if (!stopping) await gateway.start();
		if (!stopping) console.log(mode === "worker"
			? `[start-container] Ready: authenticated worker ${configuration.apiPort}.`
			: `[start-container] Ready: website ${configuration.webPort}; authenticated API ${configuration.apiPort}.`);
	} catch {
		if (!stopping) fail("Startup failed; stopping the container.");
	} finally {
		finishStartup();
	}
	if (shutdown) await shutdown;
}

if (process.argv[1] && existsSync(process.argv[1]) && pathToFileURL(realpathSync(path.resolve(process.argv[1]))).href === import.meta.url) {
	main().catch(() => {
		console.error("[start-container] Startup failed. Check the server API key, container mode, and port configuration.");
		process.exitCode = 1;
	});
}
