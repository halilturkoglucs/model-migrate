import { loadLifecycle, modelStatus } from "./lifecycle.mjs"
import { scanDirectory, uniqueModels } from "./scan.mjs"

const ACTIVE_KINDS = new Set(["runtime", "script", "config"])
const FAILING_STATES = new Set(["retired", "urgent", "not-found"])
const STATE_ORDER = ["retired", "urgent", "not-found", "unknown", "earliest-soon", "scheduled", "earliest-later", "no-date"]

export function kindCounts(usages) {
  const counts = {}
  for (const usage of usages) counts[usage.kind] = (counts[usage.kind] || 0) + 1
  return Object.entries(counts).map(([kind, count]) => `${kind} ${count}`).join(", ")
}

export async function buildStatus(root, { withinDays = 90, env = {}, fetchImpl } = {}) {
  if (!Number.isFinite(withinDays)) throw new Error("within days must be a number")
  const today = new Date().toISOString().slice(0, 10)
  const { usages } = await scanDirectory(root)
  const models = uniqueModels(usages)
  const lifecycle = await loadLifecycle(new Set(models.map(item => item.provider)), { env, ...(fetchImpl ? { fetchImpl } : {}) })
  const rows = models.map(item => ({
    ...modelStatus(item, lifecycle, { today, withinDays }),
    usedIn: kindCounts(item.usages),
    active: item.usages.some(usage => ACTIVE_KINDS.has(usage.kind)),
  })).sort((left, right) => STATE_ORDER.indexOf(left.state) - STATE_ORDER.indexOf(right.state) || left.model.localeCompare(right.model))
  const sourceErrors = Object.values(lifecycle).flatMap(source => source.errors)
  return { today, withinDays, models: rows, sourceErrors, failing: rows.filter(row => row.active && FAILING_STATES.has(row.state)) }
}
