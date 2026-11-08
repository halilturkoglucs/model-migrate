import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".venv", "venv",
  "__pycache__", "dist", "build", "out", "target", "vendor", "coverage", ".vercel",
])
const LOCK_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "poetry.lock", "uv.lock",
  "Cargo.lock", "go.sum", "composer.lock", "Gemfile.lock",
])
const TEXT_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".py", ".rb", ".go", ".rs", ".java",
  ".kt", ".swift", ".php", ".cs", ".sh", ".bash", ".zsh", ".json", ".yaml", ".yml", ".toml", ".ini",
  ".cfg", ".md", ".mdx", ".txt", ".rst", ".vue", ".svelte", ".tf",
])
const MAX_FILE_BYTES = 1_000_000

const MODEL_PATTERNS = [
  {
    provider: "openai",
    pattern: /(?<![\w.-])(?:gpt-\d[\w.-]*|gpt-image-[\w.-]+|gpt-audio[\w.-]*|gpt-realtime[\w.-]*|gpt-transcribe[\w.-]*|gpt-live[\w.-]*|chatgpt-[\w.-]+|text-embedding-[\w.-]+|whisper-1|tts-1(?:-hd)?|dall-e-\d|omni-moderation-[\w.-]+)(?![\w-])/g,
  },
  // Short o-series names are ordinary words outside string literals.
  { provider: "openai", pattern: /(?<=["'`])o[134](?:-[a-z0-9-]+)?(?=["'`])/g },
  { provider: "anthropic", pattern: /(?<![\w.-])claude-(?:[a-z]+-)*\d[\w.-]*/g },
  { provider: "gemini", pattern: /(?<![\w.-])gemini-\d[\w.-]*/g },
]

const ENDPOINT_PATTERNS = [
  ["audio.speech", /audio\/speech|\.audio\.speech/],
  ["audio.transcriptions", /audio\/transcriptions|\.audio\.transcriptions/],
  ["realtime", /\/realtime\b|\.realtime\./],
  ["responses", /\/responses\b|\.responses\.(?:create|parse|stream)/],
  ["chat.completions", /chat\/completions|\.chat\.completions/],
  ["embeddings", /\/embeddings\b|\.embeddings\.create/],
  ["anthropic.messages", /\/v1\/messages\b|\.messages\.(?:create|stream)/],
  ["gemini.generateContent", /generateContent|generate_content/],
]
const PARAMETER_PATTERN = /\b(temperature|top_p|reasoning(?:_effort)?|max_tokens|max_output_tokens|max_completion_tokens|maxOutputTokens|response_format|json_schema|thinking|thinkingConfig|voice|instructions)\b/g

const OVERRIDE_PATTERN = /process\.env|import\.meta\.env|os\.environ|os\.getenv|getenv\(|ENV\[/
const BRANCH_PATTERN = /[!=]==?\s*["'`]|["'`]\s*[!=]==?|\.includes\(|\bcase\s+["'`]|\.startsWith\(|\bin\s*[[(]/
const COST_PATTERN = /\bcost|price|pricing|\busd\b|_000_000|1e6/i

export function classifyPath(relativePath) {
  const normalized = relativePath.split(path.sep).join("/")
  const base = path.posix.basename(normalized)
  if (/(^|\/)(tests?|__tests__|spec|fixtures?)\//.test(normalized) || /\.(test|spec)\.[a-z]+$/.test(base)) return "test"
  if (/(^|\/)\.?generated[\w-]*\//.test(normalized)) return "generated"
  if (/\.(md|mdx|txt|rst)$/.test(base) || /(^|\/)docs?\//.test(normalized)) return "doc"
  if (isEnvFile(base) || /\.(ya?ml|toml|ini|cfg|tf)$/.test(base)) return "config"
  if (/(^|\/)(scripts?|tools|bin)\//.test(normalized)) return "script"
  return "runtime"
}

function isEnvFile(base) {
  return base === ".env" || base.startsWith(".env.")
}

function isScannable(name) {
  if (LOCK_FILES.has(name) || /\.min\.(js|css)$/.test(name) || name.endsWith(".map")) return false
  // Real env files hold secrets, so only committed templates are read.
  if (isEnvFile(name)) return /\.(example|sample|template|dist)$/.test(name)
  return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase())
}

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(fullPath)
    } else if (entry.isFile() && isScannable(entry.name)) {
      yield fullPath
    }
  }
}

function modelsInLine(line) {
  const found = []
  for (const { provider, pattern } of MODEL_PATTERNS) {
    for (const match of line.matchAll(pattern)) {
      // A model name inside a URL is a link, not a model the code calls.
      if (/https?:\/\/\S*$/.test(line.slice(0, match.index))) continue
      found.push({ provider, model: match[0].replace(/[.-]+$/, "") })
    }
  }
  return found
}

// Env files hold secrets, so only the variable name may ever leave this function.
function safeSnippet(line, base) {
  if (isEnvFile(base)) return `${line.split("=")[0].trim()}=<redacted>`
  return line.trim().slice(0, 160)
}

export function scanText(relativePath, text) {
  const base = path.basename(relativePath)
  const lines = text.split(/\r?\n/)
  const endpoints = ENDPOINT_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)
  const parameters = [...new Set([...text.matchAll(PARAMETER_PATTERN)].map(match => match[1]))].sort()
  const usages = []
  lines.forEach((line, index) => {
    const models = modelsInLine(line)
    if (!models.length) return
    const nearby = lines.slice(Math.max(0, index - 1), index + 6).join("\n")
    const branch = BRANCH_PATTERN.test(line)
    for (const { provider, model } of models) {
      usages.push({
        provider,
        model,
        file: relativePath,
        line: index + 1,
        kind: classifyPath(relativePath),
        envOverride: OVERRIDE_PATTERN.test(line),
        branch,
        costBranch: branch && COST_PATTERN.test(nearby),
        snippet: safeSnippet(line, base),
      })
    }
  })
  return { usages, endpoints: usages.length ? endpoints : [], parameters: usages.length ? parameters : [] }
}

export async function scanDirectory(root) {
  const usages = []
  const files = {}
  for await (const fullPath of walk(root)) {
    if ((await stat(fullPath)).size > MAX_FILE_BYTES) continue
    const relativePath = path.relative(root, fullPath)
    const result = scanText(relativePath, await readFile(fullPath, "utf8"))
    usages.push(...result.usages)
    if (result.usages.length) files[relativePath] = { endpoints: result.endpoints, parameters: result.parameters }
  }
  usages.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
  return { usages, files }
}

export function uniqueModels(usages) {
  const models = new Map()
  for (const usage of usages) {
    if (!models.has(usage.model)) models.set(usage.model, { model: usage.model, provider: usage.provider, usages: [] })
    models.get(usage.model).usages.push(usage)
  }
  return [...models.values()].sort((left, right) => left.model.localeCompare(right.model))
}
