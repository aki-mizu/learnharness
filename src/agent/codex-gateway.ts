import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import type { ModelAuth } from "@earendil-works/pi-ai";

function table(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

export function codexGatewayAuth(): ModelAuth | undefined {
	if (process.env.LH_IGNORE_ENV_KEYS === "1") return undefined;
	if (process.env.NODE_ENV === "test" && !process.env.CODEX_HOME) return undefined;
	try {
		const directory = process.env.CODEX_HOME || path.join(homedir(), ".codex");
		const config = parse(readFileSync(path.join(directory, "config.toml"), "utf8"));
		if (typeof config.model_provider !== "string") return undefined;
		const providers = table(config.model_providers);
		if (!providers || !Object.hasOwn(providers, config.model_provider)) return undefined;
		const provider = table(providers[config.model_provider]);
		if (provider?.wire_api !== "responses" || typeof provider.base_url !== "string") return undefined;

		const url = new URL(provider.base_url);
		const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
		if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return undefined;
		if (url.username || url.password || url.search || url.hash) return undefined;

		const configuredHeaders = table(provider.http_headers);
		if (!configuredHeaders || !Object.values(configuredHeaders).every((value) => typeof value === "string")) return undefined;
		const headers = new Headers(configuredHeaders as Record<string, string>);
		const bearer = headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i);
		if (!bearer) return undefined;
		return {
			apiKey: bearer[1],
			baseUrl: url.href.replace(/\/+$/, ""),
			headers: Object.fromEntries(headers),
		};
	} catch {
		return undefined;
	}
}
