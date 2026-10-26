import { createProvider, type Model, type MutableModels, type ProviderStreams } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { isCustomProviderId, type CustomProviderRecord } from "../core/custom-providers.ts";

type CustomProviderSource = () => readonly CustomProviderRecord[];
const SOURCE_KEY = Symbol.for("lh.customProviderSource");
const registrations = new WeakMap<MutableModels, Map<string, string>>();

/** Shared across Next route chunks; storage is injected by the server layer. */
export function setCustomProviderSource(source: CustomProviderSource): void {
	(globalThis as Record<symbol, CustomProviderSource | undefined>)[SOURCE_KEY] = source;
}

function records(): readonly CustomProviderRecord[] {
	return (globalThis as Record<symbol, CustomProviderSource | undefined>)[SOURCE_KEY]?.() ?? [];
}

function signature(record: CustomProviderRecord): string {
	return JSON.stringify({ baseUrl: record.baseUrl, models: record.models, apiKey: record.apiKey });
}

function customProvider(record: CustomProviderRecord) {
	const fingerprint = signature(record);
	const currentRecord = (): CustomProviderRecord => {
		const current = records().find((entry) => entry.id === record.id);
		if (!current) throw new Error("Custom provider is no longer configured");
		if (signature(current) !== fingerprint) throw new Error("Custom provider configuration changed; retry the request");
		return current;
	};
	const native = openAICompletionsApi();
	const currentModelRecord = (model: Model<"openai-completions">) => {
		const current = currentRecord();
		// A retained engine must never send a newly rotated key to its old URL.
		if (model.baseUrl !== current.baseUrl || model.provider !== current.id || !current.models.some((entry) => entry.id === model.id)) {
			throw new Error("Custom provider model configuration changed; retry the request");
		}
		return current;
	};
	const optionsFor = (model: Model<"openai-completions">, options: Parameters<ProviderStreams["streamSimple"]>[2]) => {
		const current = currentModelRecord(model);
		const transport = options?.fetch ?? globalThis.fetch;
		const guardedFetch: typeof globalThis.fetch = (input, init) => {
			// Payload callbacks and SDK retries can yield after auth resolution.
			// Recheck the connection immediately before every network dispatch.
			currentModelRecord(model);
			return transport(input, init);
		};
		return {
			...options,
			fetch: guardedFetch,
			apiKey: current.apiKey ?? "learnharness-keyless",
			// The OpenAI SDK requires a nonempty key even for keyless servers.
			// A null header suppresses its generated Authorization header.
			headers: {
				...Object.fromEntries(Object.entries(options?.headers ?? {}).filter(([name]) => name.toLowerCase() !== "authorization")),
				Authorization: current.apiKey ? `Bearer ${current.apiKey}` : null,
			},
		};
	};
	const api: ProviderStreams = {
		stream: (model, context, options) => native.stream(model, context, optionsFor(model as Model<"openai-completions">, options)),
		streamSimple: (model, context, options) => native.streamSimple(model, context, optionsFor(model as Model<"openai-completions">, options)),
	};
	return createProvider({
		id: record.id,
		name: record.name,
		baseUrl: record.baseUrl,
		auth: {
			apiKey: {
				name: record.name,
				resolve: async () => {
					const current = currentRecord();
					return { auth: { apiKey: current.apiKey ?? "learnharness-keyless", headers: current.apiKey ? undefined : { Authorization: null } } };
				},
			},
		},
		models: record.models.map((model): Model<"openai-completions"> => ({
			...model,
			api: "openai-completions",
			provider: record.id,
			baseUrl: record.baseUrl,
			// Pi requires numeric rates. The server marks these placeholders as
			// unknown in its catalog and excludes them from monetary estimates.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: {
				maxTokensField: "max_tokens",
				supportsDeveloperRole: false,
				supportsStore: false,
				supportsStrictMode: false,
			},
		})),
		api,
	});
}

/** Reconcile persisted connections on every registry access, without a restart. */
export function syncCustomProviders(models: MutableModels): void {
	let registered = registrations.get(models);
	if (!registered) registrations.set(models, registered = new Map());
	const current = records();
	const ids = new Set(current.map((record) => record.id));
	for (const id of registered.keys()) {
		if (!ids.has(id)) {
			models.deleteProvider(id);
			registered.delete(id);
		}
	}
	for (const record of current) {
		if (!isCustomProviderId(record.id)) continue;
		const fingerprint = `${record.name}\n${signature(record)}`;
		if (registered.get(record.id) === fingerprint && models.getProvider(record.id)) continue;
		models.setProvider(customProvider(record));
		registered.set(record.id, fingerprint);
	}
}
