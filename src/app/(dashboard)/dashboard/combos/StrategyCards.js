"use client";

import { Button } from "@/shared/components";
import { translate } from "@/i18n/runtime";

export const STRATEGY_CARDS = [
  {
    key: "fallback",
    name: "Fallback",
    badge: "Reliability",
    badgeColor: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
    icon: "alt_route",
    iconColor: "text-blue-500 bg-blue-500/10",
    desc: "Tries models sequentially in priority order; immediately switches to the next candidate upon upstream error or rate limit.",
  },
  {
    key: "round-robin",
    name: "Round Robin",
    badge: "Load Balance",
    badgeColor: "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20",
    icon: "autorenew",
    iconColor: "text-purple-500 bg-purple-500/10",
    desc: "Rotates models across requests evenly to spread concurrency and throughput across multiple providers.",
  },
  {
    key: "context-relay",
    name: "Context-Relay",
    badge: "Cache & Continuity",
    badgeColor: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
    icon: "bolt",
    iconColor: "text-emerald-500 bg-emerald-500/10",
    desc: "Anchors ongoing chat sessions to the same upstream target to maximize prompt cache hits (< 90% cost savings).",
  },
  {
    key: "p2c",
    name: "P2C (Power of Two)",
    badge: "Low Latency",
    badgeColor: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
    icon: "speed",
    iconColor: "text-amber-500 bg-amber-500/10",
    desc: "Picks two random candidates and selects the least loaded to avoid queue bottlenecks.",
  },
  {
    key: "reset-aware",
    name: "Reset-Aware",
    badge: "Quota Saver",
    badgeColor: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/20",
    icon: "hourglass_top",
    iconColor: "text-cyan-500 bg-cyan-500/10",
    desc: "Prioritizes accounts whose subscription quota resets soonest (< 48h) to minimize waste.",
  },
  {
    key: "fusion",
    name: "Fusion",
    badge: "Highest Quality",
    badgeColor: "bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/20",
    icon: "hub",
    iconColor: "text-pink-500 bg-pink-500/10",
    desc: "Queries all models in parallel, then a judge model synthesizes the optimal single answer (N+1 calls).",
  },
];

export function StrategyGuideHeader({ onCreate }) {
  return (
    <div className="flex flex-col gap-4">
      {/* Header title and Create Combo button */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-text-main flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-[20px]">alt_route</span>
            {translate("Routing Strategies")}
          </h2>
          <p className="text-xs text-text-muted mt-0.5">
            {translate("Group models under one unified name, then choose an execution strategy to automate routing:")}
          </p>
        </div>
        <Button
          icon="add"
          onClick={onCreate}
          className="w-full sm:w-auto whitespace-nowrap shrink-0 shadow-sm"
        >
          {translate("Create Combo")}
        </Button>
      </div>

      {/* Strategy Feature Cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {STRATEGY_CARDS.map((strat) => (
          <div
            key={strat.key}
            className="flex flex-col justify-between rounded-xl border border-border/80 bg-surface p-3.5 shadow-sm transition-all hover:border-primary/40 hover:shadow-md dark:border-border/60"
          >
            <div>
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${strat.iconColor}`}>
                  <span className="material-symbols-outlined text-[18px]">{strat.icon}</span>
                </div>
                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${strat.badgeColor}`}>
                  {translate(strat.badge)}
                </span>
              </div>
              <h3 className="text-sm font-semibold text-text-main">{translate(strat.name)}</h3>
              <p className="text-xs text-text-muted mt-1 leading-relaxed">{translate(strat.desc)}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
