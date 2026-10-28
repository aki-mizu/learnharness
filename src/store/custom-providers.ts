import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CUSTOM_PROVIDERS_FILE } from "../../config.ts";
import { isCustomProviderRecord, type CustomProviderRecord } from "../core/custom-providers.ts";

/** Private records include credentials. Only server projections may leave this adapter. */
function read(): CustomProviderRecord[] {
	let contents: string;
	try {
		contents = fs.readFileSync(CUSTOM_PROVIDERS_FILE, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	let raw: unknown;
	try { raw = JSON.parse(contents); } catch { throw new Error("Custom provider store is invalid"); }
	if (!raw || typeof raw !== "object" || !("version" in raw) || raw.version !== 1 || !("providers" in raw) || !Array.isArray(raw.providers) || !raw.providers.every(isCustomProviderRecord)) {
		throw new Error("Custom provider store is invalid");
	}
	const records: CustomProviderRecord[] = raw.providers;
	if (new Set(records.map((record) => record.id)).size !== records.length) throw new Error("Custom provider store has duplicate IDs");
	return records;
}

function write(records: readonly CustomProviderRecord[]): void {
	fs.mkdirSync(path.dirname(CUSTOM_PROVIDERS_FILE), { recursive: true });
	const tmp = `${CUSTOM_PROVIDERS_FILE}.tmp-${randomUUID()}`;
	try {
		fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, providers: records }, null, "\t")}\n`, { mode: 0o600 });
		fs.chmodSync(tmp, 0o600);
		fs.renameSync(tmp, CUSTOM_PROVIDERS_FILE);
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

export const customProviderStore = { read, write };
