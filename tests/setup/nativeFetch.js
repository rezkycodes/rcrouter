// Records the runtime's own fetch before any test file runs so open-sse/utils/proxyFetch.js can
// tell an injected test double (globalThis.fetch replaced before the module loads) from the real
// fetch. Production never sets this key; see the "Test seam" note in proxyFetch.js.
globalThis[Symbol.for("9router.nativeFetch")] = globalThis.fetch;
