import { NextResponse } from "next/server";
import { createProviderConnectionsBulk } from "@/models";
import { BULK_MAX_ITEMS, buildBulkConnectionInput } from "@/lib/providerConnectionInput";

export const dynamic = "force-dynamic";

// POST /api/providers/bulk - Create many API-key connections in one transaction.
// The whole batch is validated before anything is written (400/404/409 save
// nothing); per-item name collisions with stored connections come back in
// `results` while the rest of the batch is saved.
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    if (!Array.isArray(body?.items) || body.items.length === 0 || body.items.length > BULK_MAX_ITEMS) {
      return NextResponse.json({ error: `items must contain 1-${BULK_MAX_ITEMS} connections` }, { status: 400 });
    }

    const nodeCache = new Map();
    const inputs = [];
    const seen = new Set();
    for (const item of body.items) {
      const built = await buildBulkConnectionInput(item, { nodeCache });
      if (built.error) return NextResponse.json({ error: built.error }, { status: built.status });

      const key = `${built.input.provider}:${built.input.name}`;
      if (seen.has(key)) {
        return NextResponse.json({ error: "Duplicate provider/name in batch" }, { status: 409 });
      }
      seen.add(key);
      inputs.push({ ...built.input, allowOverwrite: item.allowOverwrite === true });
    }

    const results = await createProviderConnectionsBulk(inputs);
    return NextResponse.json({ results }, { status: 201 });
  } catch (error) {
    console.log("Error creating provider connections in bulk:", error);
    return NextResponse.json({ error: "Failed to create provider connections" }, { status: 500 });
  }
}
