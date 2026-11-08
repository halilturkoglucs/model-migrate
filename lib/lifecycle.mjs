export const SOURCES = {
  openai: "https://developers.openai.com/api/docs/deprecations.md",
  anthropic: "https://platform.claude.com/docs/en/about-claude/model-deprecations.md",
  gemini: "https://ai.google.dev/gemini-api/docs/deprecations.md.txt",
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const SNAPSHOT_SUFFIX = /-(?:\d{4}-\d{2}-\d{2}|\d{8})$/

function splitPipeRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|\s*$/, "").split(/(?<!\\)\|/).map(cell => cell.replaceAll("\\|", "|").trim())
}

function pipeTables(markdown) {
  const tables = []
  const lines = markdown.split(/\r?\n/)
  for (let index = 0; index < lines.length - 1; index++) {
    if (!lines[index].trim().startsWith("|") || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[index + 1])) continue
    const headers = splitPipeRow(lines[index])
    const rows = []
    let cursor = index + 2
    while (cursor < lines.length && lines[cursor].trim().startsWith("|")) rows.push(splitPipeRow(lines[cursor++]))
    tables.push({ headers, rows })
    index = cursor - 1
  }
  return tables
}

// Google publishes Markdoc tables: rows split by ---, cells are bullet items.
function markdocTables(markdown) {
  const tables = []
  for (const [, body] of markdown.matchAll(/\{%\s*table\s*%\}([\s\S]*?)\{%\s*\/table\s*%\}/g)) {
    const [headers, ...rows] = body.split(/^\s*---\s*$/m).map(row =>
      row.split(/^\s*\*(?:\s|$)/m).slice(1).map(cell => cell.replace(/\s+/g, " ").trim()))
    if (headers?.length) tables.push({ headers, rows })
  }
  return tables
}

export function parseDate(text) {
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (iso) return iso[0]
  const named = text.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/)
  if (!named) return null
  const month = MONTHS.indexOf(named[1].slice(0, 3).toLowerCase())
  if (month < 0) return null
  return `${named[3]}-${String(month + 1).padStart(2, "0")}-${named[2].padStart(2, "0")}`
}

function cellIds(cell) {
  const quoted = [...cell.matchAll(/`([^`]+)`/g)].map(match => match[1].trim())
  const candidates = quoted.length ? quoted : cell.split(/\s*(?:,|<br\s*\/?>|\|)\s*/)
  return candidates.filter(id => /^[a-z][a-z0-9.:-]*\d[a-z0-9.:-]*$|^[a-z]+(?:-[a-z0-9.]+)+$/.test(id))
}

function cleanReplacement(cell) {
  const text = (cell || "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replaceAll("`", "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  return !text || /^(n\/?a|none|-|—)$/i.test(text) ? null : text
}

export function parseDeprecations(markdown, provider) {
  const entries = new Map()
  for (const { headers, rows } of [...pipeTables(markdown), ...markdocTables(markdown)]) {
    const find = pattern => headers.findIndex(header => pattern.test(header) && !/price/i.test(header))
    const modelColumn = find(/model|system/i)
    const dateColumn = find(/shutdown|retirement|removal/i)
    if (modelColumn < 0 || dateColumn < 0) continue
    const replacementColumn = find(/replacement|substitute/i)
    const stateColumn = find(/state|status/i)
    for (const row of rows) {
      const dateText = row[dateColumn] || ""
      const date = parseDate(dateText)
      const entry = {
        date,
        // Google states every listed date is the earliest possible one.
        approximate: /not sooner|earliest|tentative/i.test(dateText) || (provider === "gemini" && Boolean(date)),
        replacement: replacementColumn >= 0 ? cleanReplacement(row[replacementColumn]) : null,
        retired: stateColumn >= 0 && /retired/i.test(row[stateColumn] || ""),
      }
      for (const id of cellIds(row[modelColumn] || "")) {
        const existing = entries.get(id)
        if (!existing) entries.set(id, { ...entry })
        else {
          existing.date ??= entry.date
          existing.replacement ??= entry.replacement
          existing.retired ||= entry.retired
        }
      }
    }
  }
  return entries
}

export function lookupEntry(entries, model) {
  if (entries.has(model)) return { entry: entries.get(model), match: "exact" }
  const snapshotBase = model.replace(SNAPSHOT_SUFFIX, "")
  if (snapshotBase !== model && entries.has(snapshotBase)) return { entry: entries.get(snapshotBase), match: "alias" }
  // Providers often list only dated snapshots for an alias the code uses.
  const snapshots = [...entries].filter(([id]) => id.replace(SNAPSHOT_SUFFIX, "") === model)
  if (snapshots.length) {
    snapshots.sort(([, left], [, right]) => String(right.date).localeCompare(String(left.date)))
    return { entry: snapshots[0][1], match: "snapshot" }
  }
  return { entry: null, match: "none" }
}

export function classifyState({ date, approximate, retired }, today, withinDays) {
  if (retired) return "retired"
  if (!date) return "no-date"
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
  if (approximate) return days <= withinDays ? "earliest-soon" : "earliest-later"
  if (days < 0) return "retired"
  return days <= withinDays ? "urgent" : "scheduled"
}

async function fetchText(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "model-migrate", Accept: "text/markdown,text/plain,*/*" },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

async function fetchOpenAiModels(apiKey, fetchImpl) {
  const response = await fetchImpl("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`OpenAI models API returned HTTP ${response.status}`)
  return new Map((await response.json()).data.map(model => [model.id, model]))
}

export async function loadLifecycle(providers, { fetchImpl = fetch, env = {} } = {}) {
  const lifecycle = {}
  await Promise.all([...providers].map(async provider => {
    const source = { entries: null, apiModels: null, errors: [] }
    lifecycle[provider] = source
    try {
      const entries = parseDeprecations(await fetchText(SOURCES[provider], fetchImpl), provider)
      if (!entries.size) throw new Error("page parsed to zero models, so its format may have changed")
      source.entries = entries
    } catch (error) {
      source.errors.push(`${SOURCES[provider]}: ${error.message}`)
    }
    if (provider === "openai" && env.openai) {
      try {
        source.apiModels = await fetchOpenAiModels(env.openai, fetchImpl)
      } catch (error) {
        source.errors.push(error.message)
      }
    }
  }))
  return lifecycle
}

export function modelStatus({ model, provider }, lifecycle, { today, withinDays }) {
  const source = lifecycle[provider]
  if (!source?.entries && !source?.apiModels) return { model, provider, state: "unknown", date: null, replacement: null, basis: "no source could be read" }
  const { entry, match } = source.entries ? lookupEntry(source.entries, model) : { entry: null, match: "none" }
  const apiModel = source.apiModels?.get(model)
  if (apiModel?.shutdown_date) {
    const date = apiModel.shutdown_date
    return { model, provider, date, replacement: entry?.replacement ?? null, state: classifyState({ date }, today, withinDays), basis: "provider API" }
  }
  if (entry) {
    return { model, provider, date: entry.date, replacement: entry.replacement, approximate: entry.approximate, state: classifyState(entry, today, withinDays), basis: `deprecations page (${match} match)` }
  }
  if (source.apiModels && !apiModel) return { model, provider, state: "not-found", date: null, replacement: null, basis: "absent from provider API; may be retired, a typo, or not enabled for this key" }
  return { model, provider, state: "no-date", date: null, replacement: null, basis: apiModel ? "provider API lists no shutdown date" : "not on deprecations page" }
}
