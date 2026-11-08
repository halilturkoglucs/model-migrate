const API_BASE = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
}
const KEY_NAMES = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" }
const REQUEST_TIMEOUT_MS = 120_000
const CONCURRENCY = 4
const FAILED_BODY_CHARS = 300

function outcome({ text, finished, input, cached = 0, output, reasoning = 0 }) {
  return { text, finished, usage: { input: input || 0, cached, output: output || 0, reasoning } }
}

export const ADAPTERS = {
  openai: {
    url: base => `${base}/v1/responses`,
    headers: key => ({ Authorization: `Bearer ${key}` }),
    body: ({ model, testCase, maxOutputTokens, schema, params }) => ({
      model,
      store: false,
      max_output_tokens: maxOutputTokens,
      ...(testCase.instructions ? { instructions: testCase.instructions } : {}),
      input: testCase.input,
      ...(schema ? { text: { format: { type: "json_schema", name: "comparison", strict: true, schema } } } : {}),
      ...params,
    }),
    parse: data => outcome({
      text: (data.output || []).flatMap(item => item.content || []).filter(item => item.type === "output_text").map(item => item.text).join(""),
      finished: data.status === "completed",
      input: data.usage?.input_tokens,
      cached: data.usage?.input_tokens_details?.cached_tokens,
      output: data.usage?.output_tokens,
      reasoning: data.usage?.output_tokens_details?.reasoning_tokens,
    }),
  },
  anthropic: {
    url: base => `${base}/v1/messages`,
    headers: key => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
    body: ({ model, testCase, maxOutputTokens, schema, params }) => ({
      model,
      max_tokens: maxOutputTokens,
      ...(testCase.instructions ? { system: testCase.instructions } : {}),
      messages: [{ role: "user", content: testCase.input }],
      ...(schema ? { output_config: { format: { type: "json_schema", schema } } } : {}),
      ...params,
    }),
    parse: data => outcome({
      text: (data.content || []).filter(block => block.type === "text").map(block => block.text).join(""),
      finished: data.stop_reason !== "max_tokens",
      input: (data.usage?.input_tokens || 0) + (data.usage?.cache_read_input_tokens || 0),
      cached: data.usage?.cache_read_input_tokens,
      output: data.usage?.output_tokens,
    }),
  },
  gemini: {
    url: (base, model) => `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    headers: key => ({ "x-goog-api-key": key }),
    body: ({ testCase, maxOutputTokens, schema, params }) => ({
      ...(testCase.instructions ? { systemInstruction: { parts: [{ text: testCase.instructions }] } } : {}),
      contents: [{ role: "user", parts: [{ text: testCase.input }] }],
      generationConfig: {
        maxOutputTokens,
        ...(schema ? { responseMimeType: "application/json", responseJsonSchema: schema } : {}),
        ...params,
      },
    }),
    parse: data => {
      const candidate = data.candidates?.[0]
      const reasoning = data.usageMetadata?.thoughtsTokenCount || 0
      return outcome({
        text: (candidate?.content?.parts || []).map(part => part.text || "").join(""),
        finished: candidate?.finishReason === "STOP",
        input: data.usageMetadata?.promptTokenCount,
        cached: data.usageMetadata?.cachedContentTokenCount,
        output: (data.usageMetadata?.candidatesTokenCount || 0) + reasoning,
        reasoning,
      })
    },
  },
}

export function validateConfig(config) {
  const problems = []
  if (!Array.isArray(config.models) || config.models.length < 2) problems.push("models needs a baseline and at least one candidate")
  if (!Array.isArray(config.cases) || !config.cases.length) problems.push("cases needs at least one case")
  for (const [index, model] of (config.models || []).entries()) {
    if (!ADAPTERS[model.provider]) problems.push(`models[${index}].provider must be openai, anthropic or gemini`)
    if (!model.id) problems.push(`models[${index}].id is required`)
    if (typeof model.price?.input !== "number" || typeof model.price?.output !== "number") {
      problems.push(`models[${index}].price needs numeric input and output, in USD per 1M tokens`)
    }
  }
  for (const [index, testCase] of (config.cases || []).entries()) {
    if (typeof testCase.input !== "string" || !testCase.input) problems.push(`cases[${index}].input is required`)
  }
  return problems
}

export function plannedCalls(config) {
  return config.models.length * config.cases.length * (config.runs ?? 2)
}

export function costUsd(usage, price) {
  const cachedRate = price.cachedInput ?? price.input
  return ((usage.input - usage.cached) * price.input + usage.cached * cachedRate + usage.output * price.output) / 1_000_000
}

function readPath(value, dottedPath) {
  return dottedPath.split(".").reduce((current, key) => current?.[key], value)
}

async function callModel(model, testCase, config, { env, fetchImpl, baseUrls }) {
  const adapter = ADAPTERS[model.provider]
  const key = env[KEY_NAMES[model.provider]]
  if (!key) return { error: `no ${model.provider} API key configured; set it with /plugin configure model-migrate@model-migrate` }
  const startedAt = Date.now()
  try {
    const response = await fetchImpl(adapter.url(baseUrls[model.provider], model.id), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...adapter.headers(key) },
      body: JSON.stringify(adapter.body({
        model: model.id,
        testCase,
        maxOutputTokens: config.maxOutputTokens ?? 2000,
        schema: config.schema,
        params: model.params || {},
      })),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const raw = await response.text()
    if (!response.ok) return { error: `HTTP ${response.status}: ${raw.slice(0, FAILED_BODY_CHARS)}` }
    const result = adapter.parse(JSON.parse(raw))
    let parsed
    let invalidJson = false
    if (config.schema) {
      try { parsed = JSON.parse(result.text) } catch { invalidJson = true }
    }
    const rawScore = config.scorePath && parsed ? readPath(parsed, config.scorePath) : undefined
    return {
      ...result,
      invalidJson,
      score: typeof rawScore === "number" ? rawScore : null,
      latencyMs: Date.now() - startedAt,
      cost: costUsd(result.usage, model.price),
    }
  } catch (error) {
    return { error: error.name === "TimeoutError" ? "request timed out" : error.message }
  }
}

async function pool(tasks, size) {
  const results = new Array(tasks.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++
      results[index] = await tasks[index]()
    }
  }))
  return results
}

const mean = values => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null)

function summarize(runs) {
  const ok = runs.filter(run => !run.error)
  const complete = ok.filter(run => run.finished && !run.invalidJson)
  return {
    runs: runs.length,
    errors: runs.length - ok.length,
    firstError: runs.find(run => run.error)?.error ?? null,
    truncated: ok.filter(run => !run.finished).length,
    invalidJson: ok.filter(run => run.invalidJson).length,
    avgInputTokens: mean(ok.map(run => run.usage.input)),
    avgOutputTokens: mean(ok.map(run => run.usage.output)),
    avgReasoningTokens: mean(ok.map(run => run.usage.reasoning)),
    avgLatencyMs: mean(ok.map(run => run.latencyMs)),
    costPer1000: ok.length ? mean(ok.map(run => run.cost)) * 1000 : null,
    meanScore: mean(complete.map(run => run.score).filter(score => score !== null)),
  }
}

export async function runComparison(config, { env = {}, fetchImpl = fetch, baseUrls = API_BASE } = {}) {
  const runsPerCase = config.runs ?? 2
  const tolerance = config.scoreTolerance ?? 5
  const tasks = []
  const slots = config.models.map(() => config.cases.map(() => []))
  config.models.forEach((model, modelIndex) => config.cases.forEach((testCase, caseIndex) => {
    for (let run = 0; run < runsPerCase; run++) {
      tasks.push(async () => slots[modelIndex][caseIndex].push(await callModel(model, testCase, config, { env, fetchImpl, baseUrls })))
    }
  }))
  await pool(tasks, CONCURRENCY)

  const caseScore = runs => mean(runs.filter(run => !run.error && run.finished && !run.invalidJson && run.score !== null).map(run => run.score))
  const baselineScores = slots[0].map(caseScore)
  const models = config.models.map((model, modelIndex) => {
    const summary = summarize(slots[modelIndex].flat())
    const perCase = config.cases.map((testCase, caseIndex) => {
      const score = caseScore(slots[modelIndex][caseIndex])
      const baseline = baselineScores[caseIndex]
      return {
        case: testCase.name || `case ${caseIndex + 1}`,
        score,
        delta: score !== null && baseline !== null ? score - baseline : null,
      }
    })
    const deltas = perCase.map(item => item.delta).filter(delta => delta !== null)
    const baselineCost = summarize(slots[0].flat()).costPer1000
    const failed = summary.errors || summary.truncated || summary.invalidJson
    const maxDelta = deltas.length ? Math.max(...deltas.map(Math.abs)) : null
    return {
      id: model.id,
      provider: model.provider,
      role: modelIndex === 0 ? "baseline" : "candidate",
      ...summary,
      costChangePercent: baselineCost && summary.costPer1000 !== null ? (summary.costPer1000 / baselineCost - 1) * 100 : null,
      meanDelta: mean(deltas),
      maxAbsDelta: maxDelta,
      perCase,
      verdict: failed ? "FAIL" : maxDelta !== null && maxDelta > tolerance ? "REVIEW" : "OK",
    }
  })
  return { models, tolerance, calls: tasks.length, sentOutputs: false }
}
