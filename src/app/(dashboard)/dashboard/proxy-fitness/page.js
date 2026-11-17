"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardSkeleton, Input, ConfirmModal } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import {
  buildFitnessRecords,
  filterFitnessRecords,
  fitnessProviders,
  formatRemaining,
} from "@/shared/utils/proxyFitness";

const REFRESH_MS = 30_000;
const POOLS_URL = "/api/proxy-pools";
const FITNESS_URL = "/api/proxy-pools/fitness";
const CLEAR_ALL_URL = "/api/proxy-pools/fitness/clear-all";

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
}

export default function ProxyFitnessPage() {
  const [pools, setPools] = useState([]);
  const [fitness, setFitness] = useState({});
  const [loadedAt, setLoadedAt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [provider, setProvider] = useState("all");
  const [search, setSearch] = useState("");
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const notify = useNotificationStore();

  const fetchAll = useCallback(async () => {
    try {
      const [poolsRes, fitnessRes] = await Promise.all([
        fetch(POOLS_URL, { cache: "no-store" }),
        fetch(FITNESS_URL, { cache: "no-store" }),
      ]);
      if (poolsRes.ok) setPools((await poolsRes.json()).proxyPools || []);
      if (fitnessRes.ok) {
        setFitness((await fitnessRes.json()).pools || {});
        setLoadedAt(Date.now());
        setLoadFailed(false);
      } else {
        setLoadFailed(true);
      }
    } catch (error) {
      console.log("Error fetching proxy fitness:", error);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load and periodic refresh both run from timer callbacks, so state is
  // never set synchronously inside the effect body.
  useEffect(() => {
    const initial = setTimeout(fetchAll, 0);
    const timer = setInterval(fetchAll, REFRESH_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [fetchAll]);

  const records = useMemo(() => buildFitnessRecords(fitness, pools, loadedAt), [fitness, pools, loadedAt]);
  const providers = useMemo(() => fitnessProviders(records), [records]);
  // A provider that no longer has blocks (all cleared) falls back to "all".
  const activeProvider = providers.includes(provider) ? provider : "all";
  const visible = useMemo(
    () => filterFitnessRecords(records, { provider: activeProvider, search }),
    [records, activeProvider, search]
  );
  const clearTargetCount = activeProvider === "all" ? records.length : records.filter((r) => r.provider === activeProvider).length;

  const clearOne = async (record) => {
    setBusy(true);
    try {
      await postJson(`/api/proxy-pools/${encodeURIComponent(record.poolId)}/fitness/clear`, { scope: record.scope });
      notify.success(`Cleared ${record.provider} block on ${record.poolName}`);
    } catch (error) {
      notify.error(error.message || "Failed to clear proxy fitness");
    } finally {
      setBusy(false);
      fetchAll();
    }
  };

  const clearAll = async () => {
    setBusy(true);
    try {
      await postJson(CLEAR_ALL_URL, activeProvider === "all" ? {} : { provider: activeProvider });
      notify.success("Proxy fitness cleared");
    } catch (error) {
      notify.error(error.message || "Failed to clear proxy fitness");
    } finally {
      setBusy(false);
      setConfirmClearAll(false);
      fetchAll();
    }
  };

  if (loading) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:gap-6 sm:px-0">
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:gap-6 sm:px-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold sm:text-2xl">Proxy Fitness</h1>
          <p className="mt-1 text-sm text-text-muted">
            Smart rotation skips a proxy pool while it is marked unfit for a provider or model. Blocks survive a restart and expire on their own.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
          <Button size="sm" variant="secondary" icon="refresh" onClick={fetchAll} disabled={busy}>
            Refresh
          </Button>
          {clearTargetCount > 0 && (
            <Button size="sm" variant="danger" icon="clear_all" onClick={() => setConfirmClearAll(true)} disabled={busy}>
              Clear {activeProvider === "all" ? "All" : activeProvider}
            </Button>
          )}
        </div>
      </div>

      {loadFailed && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-500">
          Could not load proxy fitness. Showing the last known state.
        </div>
      )}

      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-text-muted">
            Provider
            <select
              value={activeProvider}
              onChange={(event) => setProvider(event.target.value)}
              className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-text-main"
            >
              <option value="all">All providers</option>
              {providers.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
          <div className="w-full sm:w-72">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search pool, proxy host, model..."
              icon="search"
              className="w-full"
            />
          </div>
          <Badge variant={records.length ? "error" : "default"}>Active blocks: {records.length}</Badge>
          <span className="text-xs text-text-muted">Showing {visible.length}</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[650px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase text-text-muted">
                <th className="px-3 py-2">Provider</th>
                <th className="px-3 py-2">Model</th>
                <th className="px-3 py-2">Pool</th>
                <th className="px-3 py-2">Reason</th>
                <th className="px-3 py-2">Expires</th>
                <th className="px-3 py-2 text-right" />
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-12 text-center text-text-muted">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <span className="material-symbols-outlined text-[32px] text-text-muted/50">verified_user</span>
                      <p className="text-sm font-medium text-text-main">
                        {records.length ? "No blocks match the filter" : "No active blocks"}
                      </p>
                      <p className="text-xs">
                        {records.length ? "Change the provider or search text." : "Every proxy pool is fit for routing."}
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                visible.map((record) => (
                  <tr key={record.key} className="border-b border-border/60 transition-colors hover:bg-surface-2/40">
                    <td className="px-3 py-2.5 font-medium">{record.provider}</td>
                    <td className="px-3 py-2.5">
                      <code className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-xs">{record.modelLabel}</code>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium">{record.poolName}</div>
                      {record.proxyHost && <div className="text-xs text-text-muted">{record.proxyHost}</div>}
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge variant="error">{record.reason}</Badge>
                    </td>
                    <td className="px-3 py-2.5 text-text-muted">
                      <div>{formatRemaining(record.until, loadedAt)}</div>
                      <div className="text-xs">{new Date(record.until).toLocaleString()}</div>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Button size="sm" variant="ghost" onClick={() => clearOne(record)} disabled={busy}>
                        Clear
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <ConfirmModal
        isOpen={confirmClearAll}
        onClose={() => setConfirmClearAll(false)}
        onConfirm={clearAll}
        title="Clear proxy fitness"
        message={
          activeProvider === "all"
            ? `Clear all ${clearTargetCount} active proxy fitness blocks? Smart rotation may use these pools again right away.`
            : `Clear the ${clearTargetCount} active ${activeProvider} blocks? Smart rotation may use these pools again right away.`
        }
        confirmText="Clear"
        cancelText="Cancel"
        variant="danger"
        loading={busy}
      />
    </div>
  );
}
