import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { ADAPTERS, costUsd, runComparison, validateConfig } from "../lib/compare.mjs"
import { classifyState, loadLifecycle, lookupEntry, modelStatus, parseDate, parseDeprecations } from "../lib/lifecycle.mjs"
import { classifyPath, scanText } from "../lib/scan.mjs"

test("scan finds provider models and flags env overrides and cost branches", () => {
  const source = [
    'const MODEL = process.env.MODEL || "gpt-5.4-nano"',
    'if (MODEL === "gpt-4.1-mini") {',
    "  return tokens * 0.4 / 1_000_000",
    "}",
    'const a = "claude-opus-5-5", b = "gemini-2.5-flash-lite"',
    'await fetch("https://api.openai.com/v1/audio/speech")',
  ].join("\n")
  const { usages, endpoints } = scanText("lib/ai.ts", source)
  assert.deepEqual(usages.map(usage => usage.model), ["gpt-5.4-nano", "gpt-4.1-mini", "claude-opus-5-5", "gemini-2.5-flash-lite"])
  assert.equal(usages[0].envOverride, true)
  assert.equal(usages[1].costBranch, true)
  assert.deepEqual(endpoints, ["audio.speech"])
})

test("scan ignores links, plain words and non-model claude names", () => {
  const source = "see https://platform.openai.com/docs/models/gpt-4o\nwe use o3 here\nclaude-code is a tool\n"
  assert.equal(scanText("a.ts", source).usages.length, 0)
  assert.equal(scanText("a.ts", 'model = "o3-mini"').usages[0].model, "o3-mini")
})

test("scan never exposes env file values", () => {
  const { usages } = scanText(".env.local", "MODEL=gpt-5.4-nano # sk-secret\n")
  assert.equal(usages[0].snippet, "MODEL=<redacted>")
})

test("paths are classified", () => {
  assert.equal(classifyPath("lib/a.ts"), "runtime")
  assert.equal(classifyPath("scripts/a.mjs"), "script")
  assert.equal(classifyPath("tests/a.ts"), "test")
  assert.equal(classifyPath("README.md"), "doc")
  assert.equal(classifyPath(".env.example"), "config")
  assert.equal(classifyPath(".generated-content/batch.json"), "generated")
})

test("dates parse in provider formats", () => {
  assert.equal(parseDate("February 1, 2027"), "2027-02-01")
  assert.equal(parseDate("Jan 6, 2027"), "2027-01-06")
  assert.equal(parseDate("2027-04-01"), "2027-04-01")
  assert.equal(parseDate("To be announced"), null)
})

test("OpenAI pipe tables handle escaped pipes and snapshot aliases", () => {
  const page = "| Shutdown date | Model / system | Deprecated model price | Recommended replacement |\n| --- | --- | --- | --- |\n| Jan 20, 2027 | `gpt-realtime` \\| `gpt-realtime-2025-08-28` | $1 | `gpt-realtime-2.1` |\n| Jan 14, 2027 | `gpt-4.1-mini-2025-04-14` | $1 | `gpt-6-luna` |\n"
  const entries = parseDeprecations(page, "openai")
  assert.equal(entries.get("gpt-realtime").date, "2027-01-20")
  assert.equal(entries.get("gpt-realtime-2025-08-28").replacement, "gpt-realtime-2.1")
  const found = lookupEntry(entries, "gpt-4.1-mini")
  assert.equal(found.match, "snapshot")
  assert.equal(found.entry.replacement, "gpt-6-luna")
})

test("Anthropic tentative and retired rows", () => {
  const page = "| API model name | Current state | Deprecated | Tentative retirement date |\n| :-- | :-- | :-- | :-- |\n| claude-opus-5-5 | Active | N/A | Not sooner than September 22, 2027 |\n| claude-opus-4-1-20250805 | Retired | June 5, 2026 | August 5, 2026 |\n"
  const entries = parseDeprecations(page, "anthropic")
  assert.equal(entries.get("claude-opus-5-5").approximate, true)
  assert.equal(classifyState(entries.get("claude-opus-4-1-20250805"), "2026-01-01", 90), "retired")
  assert.equal(classifyState(entries.get("claude-opus-5-5"), "2026-11-08", 90), "earliest-later")
})

test("Gemini Markdoc tables", () => {
  const page = "{% table %}\n  * Model\n  * Release date\n  * Shutdown date\n  * Recommended replacement\n\n  ---\n\n  * `gemini-3.8-flash`\n  * September 2, 2026\n  * No shutdown date announced\n  * \n\n  ---\n\n  * `gemini-2.5-pro`\n  * June 17, 2025\n  * June 17, 2027\n  * `gemini-3.8-pro`\n\n{% /table %}\n"
  const entries = parseDeprecations(page, "gemini")
  assert.equal(entries.get("gemini-3.8-flash").date, null)
  assert.equal(entries.get("gemini-2.5-pro").approximate, true)
  assert.equal(entries.get("gemini-2.5-pro").replacement, "gemini-3.8-pro")
})

test("states classify around the window", () => {
  assert.equal(classifyState({ date: "2026-11-01" }, "2026-11-08", 90), "retired")
  assert.equal(classifyState({ date: "2026-12-01" }, "2026-11-08", 90), "urgent")
  assert.equal(classifyState({ date: "2027-12-01" }, "2026-11-08", 90), "scheduled")
  assert.equal(classifyState({ date: null }, "2026-11-08", 90), "no-date")
})

test("a failed source is unknown, never safe", async () => {
  const lifecycle = await loadLifecycle(new Set(["anthropic"]), { fetchImpl: async () => new Response("no", { status: 500 }), env: {} })
  const result = modelStatus({ model: "claude-opus-5-5", provider: "anthropic" }, lifecycle, { today: "2026-11-08", withinDays: 90 })
  assert.equal(result.state, "unknown")
  assert.equal(lifecycle.anthropic.errors.length, 1)
})

test("an unparseable page is reported instead of clearing every model", async () => {
  const lifecycle = await loadLifecycle(new Set(["openai"]), { fetchImpl: async () => new Response("# moved"), env: {} })
  assert.match(lifecycle.openai.errors[0], /zero models/)
})

test("provider API date wins and absence is not-found", () => {
  const lifecycle = { openai: { entries: new Map(), apiModels: new Map([["a-1", { id: "a-1", shutdown_date: "2027-06-01" }]]), errors: [] } }
  const options = { today: "2026-11-08", withinDays: 90 }
  assert.equal(modelStatus({ model: "a-1", provider: "openai" }, lifecycle, options).date, "2027-06-01")
  assert.equal(modelStatus({ model: "b-1", provider: "openai" }, lifecycle, options).state, "not-found")
})

test("cost separates cached input and falls back to the input rate", () => {
  assert.equal(costUsd({ input: 1_000_000, cached: 500_000, output: 1_000_000 }, { input: 2, cachedInput: 0.2, output: 10 }), 11.1)
  assert.equal(costUsd({ input: 1_000_000, cached: 500_000, output: 0 }, { input: 2, output: 10 }), 2)
})

test("adapters normalize usage", () => {
  const anthropic = ADAPTERS.anthropic.parse({ content: [{ type: "text", text: "x" }], stop_reason: "max_tokens", usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 } })
  assert.deepEqual(anthropic.usage, { input: 15, cached: 5, output: 3, reasoning: 0 })
  assert.equal(anthropic.finished, false)
  const gemini = ADAPTERS.gemini.parse({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "y" }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, thoughtsTokenCount: 6 } })
  assert.deepEqual(gemini.usage, { input: 4, cached: 0, output: 8, reasoning: 6 })
})

test("config validation requires prices and two models", () => {
  assert.equal(validateConfig({ models: [{ id: "a", provider: "openai", price: { input: 1, output: 1 } }], cases: [{ input: "x" }] }).length, 1)
  assert.match(validateConfig({ models: [{ id: "a", provider: "x" }, { id: "b", provider: "openai" }], cases: [] }).join(), /price/)
})

function fakeOpenAi(scores, overrides = {}) {
  return async (url, init) => {
    const { model } = JSON.parse(init.body)
    return new Response(JSON.stringify({
      status: "completed",
      output: [{ content: [{ type: "output_text", text: JSON.stringify({ score: scores[model] }) }] }],
      usage: { input_tokens: 100, output_tokens: 100, output_tokens_details: { reasoning_tokens: 0 } },
      ...(overrides[model] || {}),
    }))
  }
}

test("comparison reports cost change and score drift", async () => {
  const config = {
    models: [
      { id: "old", provider: "openai", price: { input: 2, output: 10 } },
      { id: "new", provider: "openai", price: { input: 1, output: 5 } },
    ],
    cases: [{ input: "x" }],
    runs: 2,
    schema: { type: "object" },
    scorePath: "score",
  }
  const report = await runComparison(config, { env: { OPENAI_API_KEY: "test" }, fetchImpl: fakeOpenAi({ old: 80, new: 90 }), baseUrls: { openai: "http://fake" } })
  assert.equal(report.models[0].verdict, "OK")
  assert.equal(report.models[1].verdict, "REVIEW")
  assert.equal(report.models[1].meanDelta, 10)
  assert.equal(Math.round(report.models[1].costChangePercent), -50)
})

test("truncated output and missing keys fail", async () => {
  const config = {
    models: [
      { id: "old", provider: "openai", price: { input: 2, output: 10 } },
      { id: "new", provider: "openai", price: { input: 1, output: 5 } },
      { id: "g", provider: "gemini", price: { input: 1, output: 5 } },
    ],
    cases: [{ input: "x" }],
    runs: 1,
  }
  const report = await runComparison(config, { env: { OPENAI_API_KEY: "test" }, fetchImpl: fakeOpenAi({}, { new: { status: "incomplete" } }), baseUrls: { openai: "http://fake" } })
  assert.equal(report.models[1].verdict, "FAIL")
  assert.equal(report.models[1].truncated, 1)
  assert.match(report.models[2].firstError, /no gemini API key/)
})

function rpc(env, messages) {
  const server = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url))
  const child = spawn(process.execPath, [server], { env: { PATH: process.env.PATH, ...env } })
  const expected = messages.filter(message => message.id !== undefined).length
  return new Promise((resolve, reject) => {
    let output = ""
    child.stdout.on("data", chunk => {
      output += chunk
      if (output.split("\n").filter(Boolean).length === expected) {
        child.kill()
        resolve(output.trim().split("\n").map(line => JSON.parse(line)))
      }
    })
    child.on("error", reject)
    for (const message of messages) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
  })
}

test("MCP server lists tools and will not make calls without confirmation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "model-migrate-"))
  const models = ["a", "b"].map(id => ({ id, provider: "openai", price: { input: 1, output: 1 } }))
  await writeFile(path.join(dir, "c.json"), JSON.stringify({ models, cases: [{ input: "x" }], runs: 2 }))
  const [init, list, plan] = await rpc({ CLAUDE_PROJECT_DIR: dir, OPENAI_API_KEY: "ambient" }, [
    { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/list" },
    { id: 3, method: "tools/call", params: { name: "compare", arguments: { config_path: "c.json" } } },
  ])
  assert.equal(init.result.protocolVersion, "2025-06-18")
  assert.deepEqual(list.result.tools.map(tool => tool.name), ["status", "compare"])
  const body = JSON.parse(plan.result.content[0].text)
  assert.equal(body.executed, false)
  assert.equal(body.plannedCalls, 4)
})

test("MCP compare ignores keys already in the environment and unexpanded placeholders", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "model-migrate-"))
  const models = ["a", "b"].map(id => ({ id, provider: "openai", price: { input: 1, output: 1 } }))
  await writeFile(path.join(dir, "c.json"), JSON.stringify({ models, cases: [{ input: "x" }], runs: 1 }))
  const [result] = await rpc({ CLAUDE_PROJECT_DIR: dir, OPENAI_API_KEY: "ambient", MODEL_MIGRATE_OPENAI_KEY: "${user_config.openai_api_key}" }, [
    { id: 1, method: "tools/call", params: { name: "compare", arguments: { config_path: "c.json", confirm_paid_calls: true } } },
  ])
  const body = JSON.parse(result.result.content[0].text)
  assert.match(body.models[0].firstError, /no openai API key/)
})
