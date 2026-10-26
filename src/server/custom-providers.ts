import { randomUUID } from "node:crypto";
import { setCustomProviderSource } from "../agent/custom-providers.ts";
import { CUSTOM_MODEL_CONTEXT_WINDOW, CUSTOM_MODEL_MAX_TOKENS, CUSTOM_THINKING_LEVELS, isCustomProviderId, type CustomProviderModel, type CustomProviderRecord } from "../core/custom-providers.ts";
import { stores } from "./stores.ts";

const DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_DISCOVERY_BYTES = 2 * 1024 * 1024;

export class CustomProviderError extends Error {
	constructor(public readonly status: number, message: string) { super(message); }
}

/** Install an IO dependency at the server boundary; agents never import the store. */
setCustomProviderSource(() => stores.customProviderStore.read());

function privateProvider(id: string): CustomProviderRecord {
	const record = isCustomProviderId(id) ? stores.customProviderStore.read().find((p) => p.id === id) : undefined;
	if (!record) throw new CustomProviderError(404, "Custom provider not found");
	return record;
}

function publicProvider(record: CustomProviderRecord) {
	return {
		id: record.id,
		name: record.name,
		baseUrl: record.baseUrl,
		models: record.models.map(({ id, name, contextWindow, maxTokens, input }) => ({
			id, name, contextWindow, maxTokens, input,
			reasoning: true,
			supportedLevels: [...CUSTOM_THINKING_LEVELS],
		})),
		apiKeyPresent: !!record.apiKey,
		pricingKnown: false as const,
	};
}

export function listCustomProviders() { return stores.customProviderStore.read().map(publicProvider); }
export function getCustomProvider(id: string) { return publicProvider(privateProvider(id)); }
export function customProviderPresent(id: string): boolean {
	return isCustomProviderId(id) && stores.customProviderStore.read().some((p) => p.id === id);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseConfig(body: unknown, previous?: CustomProviderRecord): Omit<CustomProviderRecord, "models"> {
	if (!isObject(body)) throw new CustomProviderError(400, "body must be a JSON object");
	if (Object.keys(body).some((key) => !["name", "baseUrl", "apiKey"].includes(key))) throw new CustomProviderError(400, "Supported fields: name, baseUrl, apiKey");
	if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120) throw new CustomProviderError(400, "name must be between 1 and 120 characters");
	if (typeof body.baseUrl !== "string" || !body.baseUrl.trim()) throw new CustomProviderError(400, "baseUrl must be an HTTP or HTTPS API base URL");
	let url: URL;
	try { url = new URL(body.baseUrl.trim()); } catch { throw new CustomProviderError(400, "baseUrl must be an HTTP or HTTPS API base URL"); }
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.includes("?") || url.href.includes("#")) {
		throw new CustomProviderError(400, "baseUrl must use HTTP or HTTPS without credentials, query parameters, or a fragment");
	}
	if (body.apiKey !== undefined && body.apiKey !== null && (typeof body.apiKey !== "string" || /[\s\x00-\x1f\x7f]/.test(body.apiKey.trim()))) {
		throw new CustomProviderError(400, "apiKey must be a string without whitespace, or null");
	}
	const apiKey = body.apiKey === undefined ? previous?.apiKey : typeof body.apiKey === "string" ? body.apiKey.trim() || undefined : undefined;
	return {
		id: previous?.id ?? `custom-${randomUUID()}`,
		name: body.name.trim(),
		baseUrl: url.toString().replace(/\/+$/, ""),
		...(apiKey ? { apiKey } : {}),
	};
}

function positiveInteger(...values: unknown[]): number | undefined {
	return values.find((v): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0);
}

type DiscoveredModel = Omit<CustomProviderModel, "contextWindow"> & {
	contextWindow: number | undefined;
	hasModalityMetadata: boolean;
};

function discoveryModels(body: unknown): DiscoveredModel[] {
	if (!isObject(body) || !Array.isArray(body.data)) throw new CustomProviderError(502, "Model discovery response must contain a data array");
	const models = new Map<string, DiscoveredModel>();
	for (const row of body.data) {
		if (!isObject(row) || typeof row.id !== "string" || !row.id.trim() || row.id !== row.id.trim() || /[\x00-\x1f\x7f]/.test(row.id)) throw new CustomProviderError(502, "Model discovery returned an invalid model ID");
		if (models.has(row.id)) continue;
		const architecture = isObject(row.architecture) ? row.architecture : {};
		const top = isObject(row.top_provider) ? row.top_provider : {};
		const meta = isObject(row.meta) ? row.meta : {};
		// llama.cpp's n_ctx is the serving limit; n_ctx_train can be much larger.
		const contextWindow = positiveInteger(row.contextWindow, row.context_length, top.context_length, meta.n_ctx);
		const maxTokens = positiveInteger(row.maxTokens, row.max_output_tokens, top.max_completion_tokens) ?? CUSTOM_MODEL_MAX_TOKENS;
		const modalities = row.input ?? row.input_modalities ?? architecture.input_modalities;
		models.set(row.id, {
			id: row.id,
			name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : row.id,
			contextWindow,
			maxTokens,
			input: Array.isArray(modalities) && modalities.includes("image") ? ["text", "image"] : ["text"],
			reasoning: true,
			hasModalityMetadata: modalities !== undefined,
		});
	}
	return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function discoveryBody(response: Response): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) throw new CustomProviderError(502, "Model discovery returned an empty response");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_DISCOVERY_BYTES) {
				await reader.cancel();
				throw new CustomProviderError(502, "Model discovery response is too large");
			}
			chunks.push(value);
		}
	} finally { reader.releaseLock(); }
	try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new CustomProviderError(502, "Model discovery returned invalid JSON"); }
}

/** Server-wide properties are safe to apply only to a single-model catalog. */
async function discoverProperties(config: Omit<CustomProviderRecord, "models">, signal: AbortSignal): Promise<{ contextWindow: number | undefined; vision: boolean } | undefined> {
	const url = new URL(config.baseUrl);
	url.pathname = `${url.pathname.replace(/\/v1$/, "").replace(/\/$/, "")}/props`;
	try {
		const response = await fetch(url, {
			headers: { Accept: "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
			signal,
			redirect: "error",
			cache: "no-store",
		});
		if (!response.ok) {
			await response.body?.cancel();
			return undefined;
		}
		const body = await discoveryBody(response);
		signal.throwIfAborted();
		if (!isObject(body)) return undefined;
		const generation = isObject(body.default_generation_settings) ? body.default_generation_settings : {};
		return {
			contextWindow: positiveInteger(generation.n_ctx),
			vision: isObject(body.modalities) && body.modalities.vision === true,
		};
	} catch {
		// /props is optional: unsupported endpoints retain their discovered catalog.
		return undefined;
	}
}

async function discover(config: Omit<CustomProviderRecord, "models">, requestSignal?: AbortSignal): Promise<CustomProviderModel[]> {
	const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
	const signal = requestSignal ? AbortSignal.any([timeout, requestSignal]) : timeout;
	try {
		const response = await fetch(`${config.baseUrl}/models`, {
			headers: { Accept: "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
			signal,
			redirect: "error",
			cache: "no-store",
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new CustomProviderError(502, `Model discovery failed (HTTP ${response.status})`);
		}
		const body = await discoveryBody(response);
		signal.throwIfAborted();
		const models = discoveryModels(body);
		const single = models.length === 1 ? models[0] : undefined;
		if (single && (single.contextWindow === undefined || !single.hasModalityMetadata)) {
			const properties = await discoverProperties(config, signal);
			if (properties) {
				single.contextWindow ??= properties.contextWindow;
				if (!single.hasModalityMetadata && properties.vision) single.input = ["text", "image"];
			}
		}
		// Optional probe failures may be ignored; caller cancellation must not save.
		requestSignal?.throwIfAborted();
		return models.map(({ id, name, contextWindow, maxTokens, input, reasoning }) => {
			const limit = contextWindow ?? CUSTOM_MODEL_CONTEXT_WINDOW;
			return { id, name, contextWindow: limit, maxTokens: Math.min(maxTokens, limit), input, reasoning };
		});
	} catch (error) {
		if (error instanceof CustomProviderError) throw error;
		// Do not expose upstream bodies, request URLs, or SDK errors containing credentials.
		throw new CustomProviderError(timeout.aborted ? 504 : 502, timeout.aborted ? "Model discovery timed out" : "Could not discover models from this endpoint");
	}
}

/** The read/check/write is synchronous after discovery: overlapping changes cannot resurrect stale records. */
function replaceProvider(previous: CustomProviderRecord, next: CustomProviderRecord): void {
	const records = stores.customProviderStore.read();
	const index = records.findIndex((p) => p.id === previous.id);
	if (index < 0 || JSON.stringify(records[index]) !== JSON.stringify(previous)) throw new CustomProviderError(409, "Custom provider changed during discovery; retry the request");
	records[index] = next;
	stores.customProviderStore.write(records);
}

export async function createCustomProvider(body: unknown, signal?: AbortSignal) {
	const config = parseConfig(body);
	const record: CustomProviderRecord = { ...config, models: await discover(config, signal) };
	stores.customProviderStore.write([...stores.customProviderStore.read(), record]);
	return publicProvider(record);
}

export async function updateCustomProvider(id: string, body: unknown, signal?: AbortSignal) {
	const previous = privateProvider(id);
	const config = parseConfig(body, previous);
	const record: CustomProviderRecord = { ...config, models: await discover(config, signal) };
	replaceProvider(previous, record);
	return publicProvider(record);
}

export async function refreshCustomProvider(id: string, signal?: AbortSignal) {
	const previous = privateProvider(id);
	const record = { ...previous, models: await discover(previous, signal) };
	replaceProvider(previous, record);
	return publicProvider(record);
}

export function deleteCustomProvider(id: string): void {
	privateProvider(id);
	stores.customProviderStore.write(stores.customProviderStore.read().filter((p) => p.id !== id));
}
