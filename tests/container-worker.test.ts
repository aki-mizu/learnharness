import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KEY = "launcher-worker-test-not-a-provider-key";

async function unusedPorts(count: number): Promise<number[]> {
	const reservations = await Promise.all(Array.from({ length: count }, async () => {
		const server = createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		return server;
	}));
	const ports = reservations.map((server) => (server.address() as AddressInfo).port);
	await Promise.all(reservations.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	return ports;
}

const APPLICATION = `
import { createServer } from 'node:http';
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({
    path: request.url,
    body,
    host: process.env.HOSTNAME,
    authorization: request.headers.authorization ?? null,
    desktopCapability: request.headers['x-learnharness-desktop'] ?? null,
    hasServerKey: process.env.LH_SERVER_API_KEY !== undefined,
    hasContainerMode: process.env.LH_CONTAINER_MODE !== undefined,
    hasUserMap: process.env.LH_SERVER_USERS !== undefined,
    hasWebKey: process.env.LH_WEB_API_KEY !== undefined,
  }));
});
server.listen(Number(process.env.PORT), process.env.HOSTNAME, () => {
  console.log('TEST_APPLICATION_PID ' + process.pid);
});
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
`;

test("the actual worker launcher starts through a symlink, authenticates every path and shuts down its backend", { timeout: 20_000 }, async (t) => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "lh-worker-launcher-"));
	const runtime = path.join(directory, "runtime");
	const alias = path.join(directory, "runtime-alias");
	await mkdir(runtime);
	await Promise.all([
		copyFile(path.join(ROOT, "scripts/server-gateway.mjs"), path.join(runtime, "server-gateway.mjs")),
		copyFile(path.join(ROOT, "scripts/start-container.mjs"), path.join(runtime, "start-container.mjs")),
		writeFile(path.join(runtime, "package.json"), '{"type":"module"}\n'),
		writeFile(path.join(runtime, "server.js"), APPLICATION),
	]);
	await symlink(runtime, alias, "dir");
	const [backendPort, workerPort, unusedWebPort] = await unusedPorts(3);
	assert.ok(backendPort && workerPort && unusedWebPort);
	const child = spawn(process.execPath, [path.join(alias, "start-container.mjs")], {
		cwd: directory,
		env: {
			NODE_ENV: "test", LH_CONTAINER_MODE: "worker", LH_SERVER_API_KEY: KEY,
			PORT: String(backendPort), LH_API_PORT: String(workerPort), LH_WEB_PORT: String(unusedWebPort),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let spawnError: Error | undefined;
	child.stdout.on("data", (chunk) => { stdout += String(chunk); });
	child.stderr.on("data", (chunk) => { stderr += String(chunk); });
	child.once("error", (error) => { spawnError = error; });
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			const stopped = await Promise.race([exited.then(() => true), delay(2000).then(() => false)]);
			if (!stopped) {
				child.kill("SIGKILL");
				await exited;
			}
		}
		// A failed launcher must not leave the test's dummy application alive.
		const applicationPid = /TEST_APPLICATION_PID (\d+)/.exec(stdout)?.[1];
		if (applicationPid) {
			try { process.kill(Number(applicationPid), "SIGKILL"); } catch { /* Already stopped with its launcher. */ }
		}
		await rm(directory, { recursive: true, force: true });
	});
	const origin = `http://127.0.0.1:${workerPort}`;
	const headers = { Authorization: `Bearer ${KEY}` };
	const deadline = Date.now() + 10_000;
	let ready = false;
	while (Date.now() < deadline) {
		if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
		try {
			const response = await fetch(`${origin}/api/graph`, { headers, signal: AbortSignal.timeout(500) });
			await response.arrayBuffer();
			if (response.status === 200) { ready = true; break; }
		} catch { /* Wait only for this isolated test process to become ready. */ }
		await delay(25);
	}
	assert.ok(ready, `worker failed to start through its symlink: ${spawnError?.message ?? stderr}`);
	assert.match(stdout, /Ready: authenticated worker/);
	for (const route of ["/", "/_next/static/application.js", "/api/graph"]) {
		for (const authorization of [undefined, "Bearer another-users-key"]) {
			const denied = await fetch(origin + route, {
				headers: authorization ? { Authorization: authorization } : undefined,
				signal: AbortSignal.timeout(1000),
			});
			assert.equal(denied.status, 401, route);
			await denied.arrayBuffer();
		}
		const allowed = await fetch(origin + route, {
			headers: { ...headers, "x-learnharness-desktop": "forged-desktop-capability" }, signal: AbortSignal.timeout(1000),
		});
		assert.equal(allowed.status, 200, route);
		assert.deepEqual(await allowed.json(), {
			path: route, body: "", host: "127.0.0.1", authorization: null, desktopCapability: null,
			hasServerKey: false, hasContainerMode: false, hasUserMap: false, hasWebKey: false,
		});
	}
	const body = JSON.stringify({ chatId: "test-session", text: "Independent user history" });
	const posted = await fetch(`${origin}/api/chat`, {
		method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(1000),
	});
	assert.equal(posted.status, 200);
	assert.equal((await posted.json() as { body: string }).body, body);
	await assert.rejects(fetch(`http://127.0.0.1:${unusedWebPort}/`, { signal: AbortSignal.timeout(1000) }), "worker mode must not start an unauthenticated website listener");
	child.kill("SIGTERM");
	const result = await Promise.race([
		exited,
		delay(5000).then(() => { throw new Error("worker launcher did not stop after SIGTERM"); }),
	]);
	assert.deepEqual(result, { code: 0, signal: null });
	assert.equal(stderr, "");
	await assert.rejects(fetch(`http://127.0.0.1:${backendPort}/api/graph`, { signal: AbortSignal.timeout(1000) }), "the raw backend must stop with its launcher");
});
