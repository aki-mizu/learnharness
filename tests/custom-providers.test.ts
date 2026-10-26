/** Custom provider API + installed SDK integration, entirely offline. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// All server imports follow the redirects: these tests never read real keys
// or write the developer's provider/settings records.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-custom-providers-"));
process.env.LH_DATA_DIR = tmp;
process.env.LH_AUTH_FILE = path.join(tmp, "auth.json");
process.env.OPENAI_API_KEY = "fixture-ambient-key-must-not-leak";
const originalFetch = globalThis.fetch;
const requests: Request[] = [];
const propsRequests: Request[] = [];
let discovery: (request: Request) => Promise<Response>;
let propsDiscovery: (request: Request) => Promise<Response>;
globalThis.fetch = async (input, init) => {
	const request = new Request(input, init);
	const pathname = new URL(request.url).pathname;
	if (pathname.endsWith("/models")) {
		requests.push(request.clone());
		return discovery(request);
	}
	if (pathname.endsWith("/props")) {
		propsRequests.push(request.clone());
		return propsDiscovery(request);
	}
	assert.fail("unexpected discovery network request");
};

const collectionRoute = await import("../app/api/providers/route.ts");
const providerRoute = await import("../app/api/providers/[id]/route.ts");
const refreshRoute = await import("../app/api/providers/[id]/refresh/route.ts");
const { piModels, piEngineForSpec } = await import("../src/agent/models.ts");
const {
	modelCatalog, catalogContextLimits, catalogDefaultsFor, rolePinsFor,
	clampModelsLevels, clampChatLevel, validateModelsSettings, validateChatSettings,
} = await import("../src/server/model-catalog.ts");
const { resolveSettings } = await import("../src/core/settings-resolution.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");
const { callCost } = await import("../src/server/pricing.ts");
const { CUSTOM_PROVIDERS_FILE } = await import("../config.ts");

interface ProviderDto {
	id: string;
	name: string;
	baseUrl: string;
	apiKeyPresent: boolean;
	pricingKnown: boolean;
	models: Array<{
		id: string;
		name: string;
		contextWindow: number;
		maxTokens: number;
		input: ("text" | "image")[];
		reasoning: boolean;
		supportedLevels: ("medium" | "xhigh")[];
	}>;
}
function request(method: string, body?: unknown): Request {
	return new Request("http://localhost/api/providers", {
		method,
		...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
async function create(body: { name?: string; baseUrl?: string; apiKey?: string | null } = {}): Promise<ProviderDto> {
	const response = await collectionRoute.POST(request("POST", { name: "Fixture connection", baseUrl: "https://fixture.invalid/v1", ...body }));
	assert.equal(response.status, 201, await response.clone().text());
	return (await response.json()).provider as ProviderDto;
}
async function read(id: string): Promise<ProviderDto> {
	const response = await providerRoute.GET(request("GET"), params(id));
	assert.equal(response.status, 200);
	return (await response.json()).provider as ProviderDto;
}
function sse(tool = false): Response {
	const events = [
		{ id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1, model: "fixture-chat", choices: [{ index: 0, delta: tool
			? { role: "assistant", tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "fixture_tool", arguments: '{"value":"works"}' } }] }
			: { role: "assistant", content: "Fixture answer" }, finish_reason: null }] },
		{ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } },
	];
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
const context = normalizeContext({ systemPrompt: "Fixture teacher instructions", messages: [{ role: "user", content: "Offline fixture", timestamp: 1 }], tools: [{ name: "fixture_tool", description: "Offline tool", parameters: Type.Object({ value: Type.String() }) }] });

beforeEach(() => {
	fs.rmSync(CUSTOM_PROVIDERS_FILE, { force: true });
	requests.length = 0;
	propsRequests.length = 0;
	discovery = async () => Response.json({ data: [{ id: "fixture-chat" }] });
	propsDiscovery = async () => new Response(null, { status: 404 });
	piModels();
});
after(() => {
	globalThis.fetch = originalFetch;
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("custom provider API", () => {
	it("starts empty and discovers models with isolated credentials, private storage, and redacted responses", async () => {
		assert.deepEqual(await (await collectionRoute.GET()).json(), { providers: [] });
		const key = "fixture-private-provider-key";
		const provider = await create({ name: "  My proxy  ", baseUrl: "https://fixture.invalid/v1///", apiKey: key });
		assert.match(provider.id, /^custom-/);
		assert.equal(provider.name, "My proxy");
		assert.equal(provider.baseUrl, "https://fixture.invalid/v1");
		assert.equal(provider.apiKeyPresent, true);
		assert.equal(provider.pricingKnown, false);
		assert.deepEqual(provider.models, [{ id: "fixture-chat", name: "fixture-chat", contextWindow: 32768, maxTokens: 4096, input: ["text"], reasoning: true, supportedLevels: ["medium", "xhigh"] }]);
		assert.equal(requests[0]!.url, "https://fixture.invalid/v1/models");
		assert.equal(requests[0]!.headers.get("authorization"), `Bearer ${key}`);
		assert.equal(requests[0]!.redirect, "error");
		assert.equal(fs.statSync(CUSTOM_PROVIDERS_FILE).mode & 0o777, 0o600);
		assert.ok(fs.readFileSync(CUSTOM_PROVIDERS_FILE, "utf8").includes(key));
		for (const response of [await providerRoute.GET(request("GET"), params(provider.id)), await collectionRoute.GET()]) {
			assert.equal(response.headers.get("cache-control"), "no-store");
			const text = await response.text();
			assert.ok(!text.includes(key));
			assert.ok(!text.includes('"apiKey":'));
		}
		assert.deepEqual(await read(provider.id), provider);
	});

	it("restores saved connections and catalogs in a fresh process without rediscovery", async () => {
		const provider = await create({ apiKey: "fixture-restored-private-key" });
		const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "globalThis.fetch = async () => { throw new Error('restart must not discover'); }; const {GET} = await import('./app/api/providers/route.ts'); console.log(await (await GET()).text());"], {
			cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000,
			env: { ...process.env, NODE_ENV: "test", LH_DATA_DIR: tmp, LH_AUTH_FILE: path.join(tmp, "auth.json") },
		});
		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout.trim()), { providers: [provider] });
		assert.ok(!child.stdout.includes("fixture-restored-private-key"));
	});

	it("uses supplied metadata, clamps output to context, and deduplicates discovered model IDs", async () => {
		discovery = async () => Response.json({ data: [
			{ id: "vision", name: "Vision fixture", context_length: 65536, max_output_tokens: 8192, architecture: { input_modalities: ["text", "image"] }, reasoning: true },
			{ id: "small", contextWindow: 2048, maxTokens: 4096, input: ["text"] },
			{ id: "vision" },
		] });
		const provider = await create();
		assert.equal(provider.models.length, 2);
		const vision = provider.models.find((m) => m.id === "vision")!;
		assert.deepEqual(vision, { id: "vision", name: "Vision fixture", contextWindow: 65536, maxTokens: 8192, input: ["text", "image"], reasoning: true, supportedLevels: ["medium", "xhigh"] });
		assert.equal(provider.models.find((m) => m.id === "small")!.maxTokens, 2048);
	});

	it("discovers loaded vision from props and forwards tool-result images through the SDK", async () => {
		propsDiscovery = async () => Response.json({ modalities: { vision: true } });
		const provider = await create({ baseUrl: "https://fixture.invalid/api/v1", apiKey: "fixture-vision-key" });
		assert.deepEqual(provider.models[0]!.input, ["text", "image"]);
		assert.equal(propsRequests.length, 1);
		assert.equal(propsRequests[0]!.url, "https://fixture.invalid/api/props");
		assert.equal(propsRequests[0]!.headers.get("authorization"), "Bearer fixture-vision-key");
		assert.equal(propsRequests[0]!.redirect, "error");
		assert.equal(propsRequests[0]!.cache, "no-store");
		assert.deepEqual(JSON.parse(fs.readFileSync(CUSTOM_PROVIDERS_FILE, "utf8")).providers[0].models[0].input, ["text", "image"]);
		assert.deepEqual((await read(provider.id)).models[0]!.input, ["text", "image"]);
		assert.equal(propsRequests.length, 1, "reading saved models must not probe the endpoint");
		const catalogEntry = modelCatalog().models.find((model) => model.provider === provider.id)!;
		assert.deepEqual(catalogEntry.input, ["text", "image"]);
		const engine = piEngineForSpec({ provider: provider.id, id: "fixture-chat" });
		assert.deepEqual(engine.model.input, ["text", "image"]);
		const call = await engine.streamFn(engine.model, context, { fetch: async () => sse(true) }).result();
		const toolCall = call.content.find((part) => part.type === "toolCall");
		assert.ok(toolCall && toolCall.type === "toolCall");
		let sent = 0;
		const answer = await engine.streamFn(engine.model, normalizeContext({ messages: [
			...context.messages, call,
			{ role: "toolResult", toolCallId: toolCall.id, toolName: "fixture_tool", isError: false, timestamp: 2,
				content: [{ type: "image", data: "fixture-image", mimeType: "image/png" }] },
		] }), { fetch: async (input, init) => {
			sent++;
			const body = await new Request(input, init).json();
			assert.ok(body.messages.some((message: { content: unknown }) => Array.isArray(message.content)
				&& message.content.some((part) => part.type === "image_url" && part.image_url.url === "data:image/png;base64,fixture-image")));
			return sse();
		} }).result();
		assert.equal(sent, 1);
		assert.equal(answer.stopReason, "stop", answer.errorMessage);
	});

	it("does not replace explicit modalities or apply server-wide props to multiple models", async () => {
		propsDiscovery = async () => Response.json({ modalities: { vision: true } });
		for (const data of [
			[{ id: "fixture-chat", input: ["text"] }],
			[{ id: "fixture-chat", input: ["text", "image"] }],
			[{ id: "fixture-chat", input_modalities: ["text"] }],
			[{ id: "fixture-chat", architecture: { input_modalities: ["text", "image"] } }],
			[{ id: "first" }, { id: "second" }],
		]) {
			discovery = async () => Response.json({ data });
			await create();
			assert.equal(propsRequests.length, 0);
		}
	});

	it("keeps successful discovery text-only when optional props is unsupported or invalid", async () => {
		const failures: Array<() => Promise<Response>> = [
			async () => Response.json({ modalities: { vision: false } }),
			async () => Response.json({}),
			async () => Response.json({ modalities: { vision: "true" } }),
			async () => new Response(null, { status: 404 }),
			async () => new Response("{broken-json"),
			async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
			async () => { throw new Error("fixture-private-props-transport-error"); },
		];
		for (const failure of failures) {
			propsDiscovery = failure;
			const provider = await create();
			assert.deepEqual(provider.models[0]!.input, ["text"]);
		}
		assert.equal(propsRequests.length, failures.length);
		assert.ok(propsRequests.every((request) => request.headers.get("authorization") === null));
		assert.equal(propsRequests[0]!.url, "https://fixture.invalid/props");
	});

	it("refreshes loaded vision capability without automatic probes on saved-catalog reads", async () => {
		propsDiscovery = async () => Response.json({ modalities: { vision: true } });
		const provider = await create({ baseUrl: "https://fixture.invalid/prefix" });
		assert.equal(propsRequests[0]!.url, "https://fixture.invalid/prefix/props");
		assert.deepEqual(provider.models[0]!.input, ["text", "image"]);
		propsDiscovery = async () => Response.json({ modalities: { vision: false } });
		const response = await refreshRoute.POST(request("POST"), params(provider.id));
		assert.equal(response.status, 200);
		assert.deepEqual((await read(provider.id)).models[0]!.input, ["text"]);
		assert.deepEqual(piModels().getModel(provider.id, "fixture-chat")!.input, ["text"]);
		assert.deepEqual(modelCatalog().models.find((model) => model.provider === provider.id)!.input, ["text"]);
		assert.equal(propsRequests.length, 2);
	});

	it("treats an optional props timeout as text-only without losing successful model discovery", async () => {
		const originalTimeout = AbortSignal.timeout;
		const controller = new AbortController();
		try {
			AbortSignal.timeout = () => controller.signal;
			propsDiscovery = async (request) => {
				controller.abort(new DOMException("fixture-private-props-timeout", "TimeoutError"));
				request.signal.throwIfAborted();
				assert.fail("props signal must be aborted");
			};
			const provider = await create();
			assert.deepEqual(provider.models[0]!.input, ["text"]);
		} finally { AbortSignal.timeout = originalTimeout; }
	});

	it("does not persist a provider when the caller cancels during optional props discovery", async () => {
		const controller = new AbortController();
		propsDiscovery = async () => {
			controller.abort(new Error("fixture-private-cancellation"));
			return Response.json({ modalities: { vision: true } });
		};
		const response = await collectionRoute.POST(new Request("http://localhost/api/providers", {
			method: "POST", body: JSON.stringify({ name: "Cancelled", baseUrl: "https://fixture.invalid/v1" }), signal: controller.signal,
		}));
		assert.ok(!response.ok);
		assert.ok(!(await response.text()).includes("fixture-private-cancellation"));
		assert.deepEqual(await (await collectionRoute.GET()).json(), { providers: [] });
	});

	it("immediately federates models into settings, context limits and actual SDK tool streams with unknown pricing", async () => {
		const provider = await create({ apiKey: "fixture-sdk-key" });
		const pin = { provider: provider.id, id: "fixture-chat" };
		assert.equal(providerKeyPresent(provider.id), true);
		assert.equal(validateModelsSettings({ strong: { model: pin } }).ok, true);
		assert.equal(validateChatSettings({ model: pin }).ok, true);
		const catalogEntry = modelCatalog().models.find((m) => m.provider === provider.id && m.id === pin.id)!;
		assert.ok(catalogEntry);
		assert.equal(catalogEntry.pricingKnown, false);
		assert.equal(catalogEntry.reasoning, true);
		assert.deepEqual(catalogEntry.supportedLevels, ["medium", "xhigh"]);
		assert.equal(catalogContextLimits().get(`${provider.id}:${pin.id}`), 32768);
		assert.equal(callCost({ inputTokens: 12, outputTokens: 4 }, `${provider.id}:${pin.id}`), null);
		const engine = piEngineForSpec(pin);
		let sent = 0;
		const answer = await engine.streamFn(engine.model, context, { fetch: async (input, init) => {
			sent++;
			const req = new Request(input, init), body = await req.json();
			assert.equal(req.url, "https://fixture.invalid/v1/chat/completions");
			assert.equal(req.headers.get("authorization"), "Bearer fixture-sdk-key");
			assert.equal(body.model, pin.id);
			assert.equal(body.stream, true);
			assert.equal(body.max_tokens, 4096);
			assert.equal(body.messages[0].role, "system");
			assert.equal(body.tools[0].function.name, "fixture_tool");
			assert.equal(body.reasoning_effort, "xhigh");
			return sse(true);
		} }).result();
		assert.equal(sent, 1);
		assert.equal(answer.stopReason, "toolUse", answer.errorMessage);
		assert.ok(answer.content.some((part) => part.type === "toolCall" && part.name === "fixture_tool" && part.arguments.value === "works"));
	});

	it("defaults custom reasoning to xhigh and sends medium or xhigh unchanged through the SDK", async () => {
		const provider = await create();
		const pin = { provider: provider.id, id: "fixture-chat" };
		for (const thinkingLevel of [undefined, "medium", "xhigh"] as const) {
			const expected = thinkingLevel ?? "xhigh";
			const engine = piEngineForSpec({ ...pin, thinkingLevel });
			assert.equal(engine.level, expected);
			let sent = 0;
			const answer = await engine.streamFn(engine.model, context, { fetch: async (input, init) => {
				sent++;
				const body = await new Request(input, init).json();
				assert.equal(body.reasoning_effort, expected);
				return sse();
			} }).result();
			assert.equal(sent, 1);
			assert.equal(answer.stopReason, "stop", answer.errorMessage);
		}
		assert.equal(catalogDefaultsFor(pin)?.thinkingLevel, "xhigh");
		assert.equal(catalogDefaultsFor({ ...pin, thinkingLevel: "medium" })?.thinkingLevel, "medium");
		const effective = resolveSettings({ version: 1, models: { cheap: { model: pin } } });
		assert.equal(rolePinsFor(effective.agent.models).researcher?.thinkingLevel, "xhigh");
	});

	it("keeps custom settings writes within medium and xhigh without allowing off", async () => {
		const provider = await create();
		const pin = { provider: provider.id, id: "fixture-chat" };
		assert.equal(clampModelsLevels({ strong: { model: pin } }).strong?.thinkingLevel, "xhigh");
		assert.equal(clampModelsLevels({ strong: { model: pin, thinkingLevel: "medium" } }).strong?.thinkingLevel, "medium");
		assert.equal(clampChatLevel({ model: pin, thinkingLevel: "medium" }, null).thinkingLevel, "medium");
		for (const thinkingLevel of ["off", "minimal", "low", "high", "max"] as const) {
			assert.equal(clampModelsLevels({ strong: { model: pin, thinkingLevel } }).strong?.thinkingLevel, "xhigh");
			assert.equal(clampChatLevel({ model: pin, thinkingLevel }, null).thinkingLevel, "xhigh");
			assert.equal(clampChatLevel({ thinkingLevel }, { ...pin, thinkingLevel: "medium" }).thinkingLevel, "xhigh");
		}
	});

	it("supports independent connections with colliding model IDs and keyless servers without ambient authentication", async () => {
		const keyed = await create({ apiKey: "fixture-only-first-key" });
		const keyless = await create({ name: "Local", baseUrl: "http://localhost:11434/v1" });
		assert.notEqual(keyed.id, keyless.id);
		assert.equal(keyless.apiKeyPresent, false);
		assert.equal(requests.at(-1)!.headers.get("authorization"), null);
		assert.equal(modelCatalog().models.filter((m) => [keyed.id, keyless.id].includes(m.provider)).length, 2);
		const engine = piEngineForSpec({ provider: keyless.id, id: "fixture-chat" });
		let sent = 0;
		const answer = await engine.streamFn(engine.model, context, { fetch: async (input, init) => {
			sent++;
			const req = new Request(input, init);
			assert.equal(req.url, "http://localhost:11434/v1/chat/completions");
			assert.equal(req.headers.get("authorization"), null);
			return sse();
		} }).result();
		assert.equal(sent, 1);
		assert.equal(answer.stopReason, "stop", answer.errorMessage);
	});

	it("updates endpoint/catalog immediately, retains an omitted key, and explicitly clears a key", async () => {
		const provider = await create({ apiKey: "fixture-retained-key" });
		const oldEngine = piEngineForSpec({ provider: provider.id, id: "fixture-chat" });
		discovery = async () => Response.json({ data: [{ id: "replacement-chat" }] });
		const response = await providerRoute.PUT(request("PUT", { name: "Renamed", baseUrl: "https://other.invalid/api" }), params(provider.id));
		assert.equal(response.status, 200);
		assert.equal(requests.at(-1)!.url, "https://other.invalid/api/models");
		assert.equal(requests.at(-1)!.headers.get("authorization"), "Bearer fixture-retained-key");
		assert.equal(piModels().getModel(provider.id, "fixture-chat"), undefined);
		assert.ok(piModels().getModel(provider.id, "replacement-chat"));
		const stale = await oldEngine.streamFn(oldEngine.model, context, { fetch: async () => { assert.fail("retained engine dispatched to old endpoint"); } }).result();
		assert.equal(stale.stopReason, "error");
		const clear = await providerRoute.PUT(request("PUT", { name: "Renamed", baseUrl: "https://other.invalid/api", apiKey: null }), params(provider.id));
		assert.equal(clear.status, 200);
		assert.equal((await read(provider.id)).apiKeyPresent, false);
		assert.equal(requests.at(-1)!.headers.get("authorization"), null);
		assert.ok(!fs.readFileSync(CUSTOM_PROVIDERS_FILE, "utf8").includes("fixture-retained-key"));
	});

	it("refreshes catalogs explicitly and preserves the previous record after failed refresh/update discovery", async () => {
		const provider = await create({ apiKey: "fixture-error-private-key" });
		discovery = async () => Response.json({ data: [{ id: "refreshed-chat", top_provider: { context_length: 8192, max_completion_tokens: 1024 } }] });
		const refresh = await refreshRoute.POST(request("POST"), params(provider.id));
		assert.equal(refresh.status, 200);
		const refreshed = await read(provider.id);
		assert.equal(refreshed.models[0]!.id, "refreshed-chat");
		assert.equal(refreshed.models[0]!.contextWindow, 8192);
		assert.equal(refreshed.models[0]!.maxTokens, 1024);
		discovery = async () => Response.json({ error: { message: "fixture-error-private-key upstream body must not leave server" } }, { status: 401 });
		for (const failure of [await refreshRoute.POST(request("POST"), params(provider.id)), await providerRoute.PUT(request("PUT", { name: "Failed update", baseUrl: "https://failed.invalid/v1", apiKey: "fixture-new-key" }), params(provider.id))]) {
			assert.equal(failure.status, 502);
			assert.ok(!(await failure.text()).includes("fixture-error-private-key"));
			assert.deepEqual(await read(provider.id), refreshed);
		}
		assert.ok(piModels().getModel(provider.id, "refreshed-chat"));
	});

	it("rejects invalid input before contacting an endpoint or changing persisted state", async () => {
		const badBodies = [null, [], {}, { name: "", baseUrl: "https://fixture.invalid/v1" }, { name: "Fixture", baseUrl: "ftp://fixture.invalid/v1" }, { name: "Fixture", baseUrl: "https://user:pass@fixture.invalid/v1" }, { name: "Fixture", baseUrl: "https://fixture.invalid/v1?key=secret" }, { name: "Fixture", baseUrl: "https://fixture.invalid/v1#fragment" }, { name: "Fixture", baseUrl: "https://fixture.invalid/v1", apiKey: 7 }, { name: "Fixture", baseUrl: "https://fixture.invalid/v1", apiKey: "a\nb" }];
		for (const body of badBodies) assert.equal((await collectionRoute.POST(request("POST", body))).status, 400, JSON.stringify(body));
		assert.equal((await collectionRoute.POST(new Request("http://localhost/api/providers", { method: "POST", body: "{bad-json" }))).status, 400);
		assert.equal(requests.length, 0);
		assert.deepEqual(await (await collectionRoute.GET()).json(), { providers: [] });
	});

	it("rejects malformed discovery responses and redacts transport failures", async () => {
		for (const body of [{}, { data: {} }, { data: [null] }, { data: [{ id: "" }] }]) {
			discovery = async () => Response.json(body);
			assert.equal((await collectionRoute.POST(request("POST", { name: "Bad discovery", baseUrl: "https://fixture.invalid/v1" }))).status, 502);
		}
		discovery = async () => new Response("{broken-json");
		assert.equal((await collectionRoute.POST(request("POST", { name: "Bad discovery", baseUrl: "https://fixture.invalid/v1" }))).status, 502);
		discovery = async () => { throw new Error("fixture-secret-key in private transport details"); };
		const failure = await collectionRoute.POST(request("POST", { name: "Failed discovery", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-secret-key" }));
		assert.equal(failure.status, 502);
		assert.ok(!(await failure.text()).includes("fixture-secret-key"));
		assert.deepEqual(await (await collectionRoute.GET()).json(), { providers: [] });
	});

	it("bounds discovery response size and reports discovery timeouts without exposing upstream errors", async () => {
		discovery = async () => new Response("x".repeat(2 * 1024 * 1024 + 1));
		assert.equal((await collectionRoute.POST(request("POST", { name: "Oversized", baseUrl: "https://fixture.invalid/v1" }))).status, 502);
		const originalTimeout = AbortSignal.timeout;
		try {
			AbortSignal.timeout = () => AbortSignal.abort(new DOMException("fixture-private-timeout-detail", "TimeoutError"));
			discovery = async (req) => { req.signal.throwIfAborted(); assert.fail("timeout signal should already be aborted"); };
			const timeout = await collectionRoute.POST(request("POST", { name: "Timeout", baseUrl: "https://fixture.invalid/v1" }));
			assert.equal(timeout.status, 504);
			assert.ok(!(await timeout.text()).includes("fixture-private-timeout-detail"));
		} finally { AbortSignal.timeout = originalTimeout; }
		assert.deepEqual(await (await collectionRoute.GET()).json(), { providers: [] });
	});

	it("does not resurrect a deleted provider when an earlier refresh finishes", async () => {
		const provider = await create();
		let started!: () => void;
		let release!: (response: Response) => void;
		const reached = new Promise<void>((resolve) => { started = resolve; });
		discovery = async () => { started(); return new Promise<Response>((resolve) => { release = resolve; }); };
		const pending = refreshRoute.POST(request("POST"), params(provider.id));
		await reached;
		assert.equal((await providerRoute.DELETE(request("DELETE"), params(provider.id))).status, 200);
		release(Response.json({ data: [{ id: "must-not-resurrect" }] }));
		assert.ok([404, 409].includes((await pending).status));
		assert.equal((await providerRoute.GET(request("GET"), params(provider.id))).status, 404);
		assert.equal(piModels().getProvider(provider.id), undefined);
	});

	it("deletes providers immediately and leaves built-in provider registrations intact", async () => {
		const provider = await create();
		const native = piModels().getProvider("openai");
		assert.ok(native);
		const engine = piEngineForSpec({ provider: provider.id, id: "fixture-chat" });
		assert.equal((await providerRoute.DELETE(request("DELETE"), params(provider.id))).status, 200);
		assert.equal(providerKeyPresent(provider.id), false);
		assert.equal(piModels().getProvider(provider.id), undefined);
		assert.equal(validateChatSettings({ model: { provider: provider.id, id: "fixture-chat" } }).ok, false);
		const answer = await engine.streamFn(engine.model, context, { fetch: async () => { assert.fail("deleted provider dispatched"); } }).result();
		assert.equal(answer.stopReason, "error");
		assert.equal(piModels().getProvider("openai"), native);
		for (const id of ["openai", "custom-missing", "../auth.json"]) {
			assert.equal((await providerRoute.GET(request("GET"), params(id))).status, 404);
			assert.equal((await providerRoute.PUT(request("PUT", { name: "No", baseUrl: "https://fixture.invalid/v1" }), params(id))).status, 404);
		}
	});

	it("revokes dispatch when a provider is deleted during an asynchronous payload observer", async () => {
		const provider = await create({ apiKey: "fixture-revoked-before-dispatch" });
		const engine = piEngineForSpec({ provider: provider.id, id: "fixture-chat" });
		let sent = 0;
		const answer = await engine.streamFn(engine.model, context, {
			onPayload: async () => { await providerRoute.DELETE(request("DELETE"), params(provider.id)); },
			fetch: async () => { sent++; return sse(); },
		}).result();
		assert.equal(sent, 0, "a deleted provider must not dispatch after an awaited observer");
		assert.equal(answer.stopReason, "error");
	});
});
