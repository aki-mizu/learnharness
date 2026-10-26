/** Persistent configuration for API-managed OpenAI-compatible connections. */
export const CUSTOM_PROVIDER_PREFIX = "custom-";
export const CUSTOM_MODEL_CONTEXT_WINDOW = 32_768;
export const CUSTOM_MODEL_MAX_TOKENS = 16_384;
export const CUSTOM_THINKING_LEVELS = ["medium", "xhigh"] as const;
export const CUSTOM_DEFAULT_THINKING_LEVEL = "xhigh";

/** Custom connections always use the fixed two-level reasoning policy. */
export function customThinkingLevel(level?: string): (typeof CUSTOM_THINKING_LEVELS)[number] {
	return level === "medium" ? level : CUSTOM_DEFAULT_THINKING_LEVEL;
}

export interface CustomProviderModel {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	input: ("text" | "image")[];
	reasoning: boolean;
}

/** Private storage shape. API responses must omit apiKey. */
export interface CustomProviderRecord {
	id: string;
	name: string;
	baseUrl: string;
	models: CustomProviderModel[];
	apiKey?: string;
}

export function isCustomProviderId(id: string): boolean {
	return id.startsWith(CUSTOM_PROVIDER_PREFIX);
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function model(value: unknown): value is CustomProviderModel {
	return object(value) && nonempty(value.id) && nonempty(value.name)
		&& positiveInteger(value.contextWindow) && positiveInteger(value.maxTokens)
		&& value.maxTokens <= value.contextWindow
		&& Array.isArray(value.input) && value.input.includes("text")
		&& value.input.every((entry) => entry === "text" || entry === "image")
		&& typeof value.reasoning === "boolean";
}

/** Reject malformed disk records before they can enter the runtime registry. */
export function isCustomProviderRecord(value: unknown): value is CustomProviderRecord {
	if (!object(value) || !nonempty(value.id) || !/^custom-[a-f0-9-]{36}$/i.test(value.id)
		|| !nonempty(value.name) || !nonempty(value.baseUrl)
		|| (value.apiKey !== undefined && (!nonempty(value.apiKey) || /[\s\x00-\x1f\x7f]/.test(value.apiKey)))
		|| !Array.isArray(value.models) || !value.models.every(model)) return false;
	try {
		const url = new URL(value.baseUrl);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.includes("?") || url.href.includes("#")) return false;
	} catch {
		return false;
	}
	return new Set(value.models.map((entry) => entry.id)).size === value.models.length;
}
