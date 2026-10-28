import { deleteCustomProvider, getCustomProvider, updateCustomProvider } from "@/src/server";
import { providerResponse } from "../response.ts";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
	const { id } = await params;
	return providerResponse(() => ({ provider: getCustomProvider(id) }));
}

export async function PUT(request: Request, { params }: Context) {
	const { id } = await params;
	return providerResponse(async () => ({ provider: await updateCustomProvider(id, await request.json().catch(() => null), request.signal) }));
}

export async function DELETE(_request: Request, { params }: Context) {
	const { id } = await params;
	return providerResponse(() => { deleteCustomProvider(id); return { ok: true }; });
}
