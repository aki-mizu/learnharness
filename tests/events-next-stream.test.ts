import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { emit } from "../src/core/events.ts";
import { eventsResponse } from "../src/server/events-stream.ts";

interface Worker {
	server: Server;
	start(): Promise<void>;
	close(): Promise<void>;
}
interface Router {
	webServer: Server;
	apiServer: Server;
	start(): Promise<void>;
	close(): Promise<void>;
}
const require = createRequire(import.meta.url);
const { pipeToNodeResponse } = require("next/dist/server/pipe-readable.js") as {
	pipeToNodeResponse(body: ReadableStream<Uint8Array>, response: ServerResponse): Promise<void>;
};
const { createServerGateway, createWorkerGateway } = require("../scripts/server-gateway.mjs") as {
	createWorkerGateway(options: { apiKey: string; upstreamUrl: string; port: number; host: string }): Worker;
	createServerGateway(options: {
		users: Array<{ id: string; apiKey: string; upstreamUrl: string }>;
		webApiKey: string; webPort: number; apiPort: number; host: string;
	}): Router;
};
const KEY = "events-next-stream-test-server-key";
const HOST = "127.0.0.1";

function port(server: Server): number {
	return (server.address() as AddressInfo).port;
}

function listenerCount(): number {
	return (globalThis as typeof globalThis & { __lhEventBus?: Set<unknown> }).__lhEventBus?.size ?? 0;
}

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
	const decoder = new TextDecoder();
	let frame = "";
	while (!frame.includes("\n\n")) {
		const chunk = await reader.read();
		assert.equal(chunk.done, false, "notification streams stay open between frames");
		frame += decoder.decode(chunk.value, { stream: true });
	}
	return frame;
}

for (const listener of ["api", "web"] as const) {
	test(`${listener} event stream attaches before the first notification through Next and both gateway hops`, { timeout: 5000 }, async (t) => {
		const initialListeners = listenerCount();
		const pipeErrors: unknown[] = [];
		const raw = createServer((_request, outgoing) => {
			const response = eventsResponse();
			outgoing.statusCode = response.status;
			response.headers.forEach((value, name) => outgoing.setHeader(name, value));
			// Use Next's actual writer: unlike a fixture that flushes headers,
			// it sends the HTTP handshake only when the first body chunk lands.
			void pipeToNodeResponse(response.body!, outgoing).catch((error: unknown) => {
				pipeErrors.push(error);
				outgoing.destroy(error instanceof Error ? error : undefined);
			});
		});
		t.after(() => new Promise<void>((resolve) => {
			raw.close(() => resolve());
			raw.closeAllConnections();
		}));
		await new Promise<void>((resolve, reject) => {
			raw.once("error", reject);
			raw.listen(0, HOST, resolve);
		});
		const worker = createWorkerGateway({ apiKey: KEY, upstreamUrl: `http://${HOST}:${port(raw)}`, port: 0, host: HOST });
		t.after(() => worker.close());
		await worker.start();
		const router = createServerGateway({
			users: [{ id: "primary", apiKey: KEY, upstreamUrl: `http://${HOST}:${port(worker.server)}` }],
			webApiKey: KEY, webPort: 0, apiPort: 0, host: HOST,
		});
		t.after(() => router.close());
		await router.start();
		const response = await fetch(`http://${HOST}:${port(listener === "api" ? router.apiServer : router.webServer)}/api/events`, {
			headers: listener === "api" ? { Authorization: `Bearer ${KEY}` } : undefined,
			signal: AbortSignal.timeout(1500),
		});
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "text/event-stream");
		assert.equal(response.headers.get("x-accel-buffering"), "no");
		assert.equal(listenerCount(), initialListeners + 1);
		const reader = response.body!.getReader();
		t.after(async () => { await reader.cancel().catch(() => {}); });
		assert.equal(await readFrame(reader), ": ping\n\n", "the handshake uses a comment without requiring any application event");
		emit("chats-changed", {});
		assert.equal(await readFrame(reader), "event: chats-changed\ndata: {}\n\n");
		await reader.cancel();
		const cleanupDeadline = Date.now() + 1000;
		while (listenerCount() !== initialListeners && Date.now() < cleanupDeadline) await delay(10);
		assert.equal(listenerCount(), initialListeners, "disconnecting cancels the real event subscription through both proxy hops");
		assert.deepEqual(pipeErrors, []);
	});
}
