#!/usr/bin/env node
// Local stdio MCP server. It exists so API keys come from the plugin's secure
// userConfig, and is the only part of the plugin that receives them.
import { readFile } from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"
import { plannedCalls, runComparison, validateConfig } from "../lib/compare.mjs"
import { buildStatus } from "../lib/report.mjs"

const PROTOCOL_VERSION = "2025-06-18"
const VERSION = "0.2.1"

// Unset options can arrive empty or as an unexpanded placeholder.
function configuredKey(value) {
  return value && !value.startsWith("${") ? value : undefined
}

// Only the plugin's own variables are read, never credentials already in the user's environment.
function pluginKeys() {
  return {
    openai: configuredKey(process.env.CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY),
    anthropic: configuredKey(process.env.CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY),
    gemini: configuredKey(process.env.CLAUDE_PLUGIN_OPTION_GEMINI_API_KEY),
  }
}

function resolvePath(target = ".") {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd(), target)
}

const TOOLS = [
  {
    name: "status",
    description: "Scan a local directory for OpenAI, Anthropic and Gemini model IDs and report each model's shutdown date from public provider pages. If an OpenAI key is configured, it also reads the OpenAI models API.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Directory to scan, relative to the project root. Defaults to the project root." },
        within_days: { type: "number", description: "Models shutting down within this many days are reported as urgent. Defaults to 90." },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async ({ path: target, within_days: withinDays = 90 }) => {
      const { failing, ...report } = await buildStatus(resolvePath(target), { withinDays, env: pluginKeys() })
      return { ...report, failingCount: failing.length }
    },
  },
  {
    name: "compare",
    description: "Run the models in a JSON config on the same test cases and report cost, latency, truncation, invalid JSON and score drift against the first model. With confirm_paid_calls true, it sends every case to the listed providers using the configured API keys, which costs money. Otherwise it only reports the planned calls.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["config_path"],
      properties: {
        config_path: { type: "string", description: "Path to the JSON config, relative to the project root." },
        confirm_paid_calls: { type: "boolean", description: "Set to true only after the user has approved the call count and providers." },
      },
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
    run: async ({ config_path: configPath, confirm_paid_calls: confirmed = false }) => {
      const config = JSON.parse(await readFile(resolvePath(configPath), "utf8"))
      const problems = validateConfig(config)
      if (problems.length) throw new Error(`invalid config:\n- ${problems.join("\n- ")}`)
      if (confirmed !== true) {
        return {
          executed: false,
          plannedCalls: plannedCalls(config),
          providers: [...new Set(config.models.map(model => model.provider))],
          note: "No calls were made. Get the user's approval, then call again with confirm_paid_calls true.",
        }
      }
      return { executed: true, ...(await runComparison(config, { env: pluginKeys() })) }
    },
  },
]

async function handle(request) {
  const { method, params } = request
  if (method === "initialize") {
    return {
      protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "model-migrate", version: VERSION },
    }
  }
  if (method === "ping") return {}
  if (method === "tools/list") return { tools: TOOLS.map(({ run, ...tool }) => tool) }
  if (method === "tools/call") {
    const tool = TOOLS.find(item => item.name === params?.name)
    if (!tool) throw Object.assign(new Error(`unknown tool: ${params?.name}`), { code: -32602 })
    try {
      const result = await tool.run(params.arguments || {})
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
    } catch (error) {
      return { content: [{ type: "text", text: `model-migrate: ${error.message}` }], isError: true }
    }
  }
  throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 })
}

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)

readline.createInterface({ input: process.stdin }).on("line", async line => {
  if (!line.trim()) return
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })
  }
  if (request.id === undefined) return
  try {
    send({ jsonrpc: "2.0", id: request.id, result: await handle(request) })
  } catch (error) {
    send({ jsonrpc: "2.0", id: request.id, error: { code: error.code || -32603, message: error.message } })
  }
})
