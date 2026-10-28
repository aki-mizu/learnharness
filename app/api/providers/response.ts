import { CustomProviderError } from "@/src/server";

export async function providerResponse(action: () => unknown | Promise<unknown>, status = 200): Promise<Response> {
	try {
		return Response.json(await action(), { status, headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		if (!(error instanceof CustomProviderError)) throw error;
		return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
	}
}
