// Cloud Worker compatibility shim. The edge handler does not persist local
// request details; these no-op functions keep shared open-sse imports portable.
export function saveRequestUsage() {}
export function appendRequestLog() {}
export function saveRequestDetail() {}
export function trackPendingRequest() {}
