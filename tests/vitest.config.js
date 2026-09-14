import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const cloudEmbeddingsAvailable = existsSync(
  resolve(__dirname, "../cloud/src/handlers/embeddings.js"),
);

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.test.js"],
    // Don't scan into git worktrees nested under .claude/ — they carry their
    // own copies of the test files but lack an installed node_modules (open-sse,
    // etc.), which makes provider imports fail during collection.
    exclude: [
      "**/node_modules/**",
      "**/.claude/**",
      "**/dist/**",
      // RcRouter is the standalone dashboard/runtime checkout. The optional
      // Cloudflare Worker tree is not shipped here; run its fixture from the
      // full upstream checkout when cloud/src/handlers/embeddings.js exists.
      ...(cloudEmbeddingsAvailable ? [] : ["**/embeddings.cloud.test.js"]),
    ],
    // Allow many it.concurrent cases (real provider smoke runs ~50 providers in parallel)
    maxConcurrency: 60,
    // Several integration fixtures intentionally replace process-wide fetch
    // and DATA_DIR. Serialise files so those scoped mocks cannot race across
    // workers; individual concurrent tests remain covered by maxConcurrency.
    fileParallelism: false,
    // Suppress noisy console output from handlers under test
    silent: false,
  },
  resolve: {
    // Use array form so subpath aliases (e.g. "@/lib/db/index.js") resolve correctly.
    alias: [
      { find: /^open-sse\//, replacement: resolve(__dirname, "../open-sse") + "/" },
      { find: "open-sse", replacement: resolve(__dirname, "../open-sse") },
      { find: /^@\//, replacement: resolve(__dirname, "../src") + "/" },
    ],
  },
});
