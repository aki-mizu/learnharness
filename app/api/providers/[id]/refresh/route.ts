import { refreshCustomProvider } from "@/src/server";
import { providerResponse } from "../../response.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return providerResponse(async () => ({ provider: await refreshCustomProvider(id, request.signal) }));
}
