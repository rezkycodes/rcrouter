import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

// The dashboard shows the history of the code that is actually running, so the changelog
// is read from the CHANGELOG.md that ships with the app (next to server.js in the CLI
// package and the Docker image, the repository root under `next dev`), not from GitHub.
export async function GET() {
  try {
    const text = await fs.promises.readFile(path.join(process.cwd(), "CHANGELOG.md"), "utf8");
    return new Response(text, {
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Response.json({ error: "CHANGELOG.md is not bundled with this build" }, { status: 404 });
    }
    console.error("[api/changelog] cannot read CHANGELOG.md:", error?.message || error);
    return Response.json({ error: "Cannot read the changelog" }, { status: 500 });
  }
}
