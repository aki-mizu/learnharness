import { createCustomProvider, listCustomProviders } from "@/src/server";
import { providerResponse } from "./response.ts";

export const dynamic = "force-dynamic";

export async function GET() {
	return providerResponse(() => ({ providers: listCustomProviders() }));
}

export async function POST(request: Request) {
	return providerResponse(async () => ({ provider: await createCustomProvider(await request.json().catch(() => null), request.signal) }), 201);
}
