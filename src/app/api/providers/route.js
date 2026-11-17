import { NextResponse } from "next/server";
import {
  getProviderConnections,
  createProviderConnection,
  getProviderNodes,
} from "@/models";
import { AI_PROVIDERS, isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { buildApiKeyConnectionInput } from "@/lib/providerConnectionInput";
import { toProviderConnectionResponse } from "@/lib/providerConnectionResponse";

export const dynamic = "force-dynamic";

// GET /api/providers - List all connections
export async function GET() {
  try {
    const connections = await getProviderConnections();

    // Build nodeNameMap for compatible providers (id → name)
    let nodeNameMap = {};
    try {
      const nodes = await getProviderNodes();
      for (const node of nodes) {
        if (node.id && node.name) nodeNameMap[node.id] = node.name;
      }
    } catch { }

    // Hide sensitive fields, enrich name for compatible providers
    const safeConnections = connections.map(c => {
      const isCompatible = isOpenAICompatibleProvider(c.provider) || isAnthropicCompatibleProvider(c.provider);
      const name = isCompatible
        ? (c.name || nodeNameMap[c.provider] || c.providerSpecificData?.nodeName || c.provider)
        : c.name;
      const providerDef = AI_PROVIDERS[c.provider];
      return {
        ...toProviderConnectionResponse(c),
        name,
        alias: providerDef?.alias || null,
        apiKey: undefined,
        accessToken: undefined,
        refreshToken: undefined,
        idToken: undefined,
      };
    });

    // Build alias → provider ID map for frontend ACL resolution
    const aliasMap = {};
    for (const [id, def] of Object.entries(AI_PROVIDERS)) {
      if (def.alias && def.alias !== id) aliasMap[def.alias] = id;
      for (const alias of def.aliases || []) aliasMap[alias] = id;
    }

    // Include all registered providers (not just those with connections) so
    // the ACL dialog can show free/noAuth providers even when no connection exists.
    const providers = Object.entries(AI_PROVIDERS).map(([id, def]) => ({
      id,
      alias: def.alias || null,
      aliases: def.aliases || [],
      displayName: def.display?.name || id,
      noAuth: !!def.noAuth,
      serviceKinds: def.serviceKinds || [],
    }));

    return NextResponse.json({ connections: safeConnections, aliasMap, providers });
  } catch (error) {
    console.log("Error fetching providers:", error);
    return NextResponse.json({ error: "Failed to fetch providers" }, { status: 500 });
  }
}

// POST /api/providers - Create new connection (API Key only, OAuth via separate flow)
export async function POST(request) {
  try {
    const body = await request.json();

    // Validation, provider rules, node hydration and proxy defaults are shared with
    // POST /api/providers/bulk (src/lib/providerConnectionInput.js).
    const built = await buildApiKeyConnectionInput(body);
    if (built.error) {
      return NextResponse.json({ error: built.error }, { status: built.status });
    }

    const newConnection = await createProviderConnection({
      ...built.input,
      // POST with an id is an explicit edit of that connection; without one, a
      // name collision is refused rather than silently overwriting a key. #4311
      allowOverwrite: body.id ? true : (body.allowOverwrite === true || body.overwrite === true),
    });

    return NextResponse.json(
      { connection: toProviderConnectionResponse(newConnection) },
      { status: 201 },
    );
  } catch (error) {
    if (error?.code === "PROVIDER_NAME_CONFLICT") {
      return NextResponse.json(
        { error: error.message, code: error.code, existingId: error.existingId, existingName: error.existingName },
        { status: 409 }
      );
    }
    console.log("Error creating provider:", error);
    return NextResponse.json({ error: "Failed to create provider" }, { status: 500 });
  }
}
