# Model Migrate

Replace AI models before they break production, and find out what the new model changes first.

Replacing a model ID is the easy part. A listed replacement can use a different endpoint, reject your parameters, spend your output limit on reasoning, cost more, or change the results your product depends on.

Model Migrate is a Claude Code plugin that:

- finds OpenAI, Anthropic and Gemini model IDs in your code
- flags env overrides, and cost code that silently breaks on an unlisted model
- checks shutdown dates from each provider's current data, not a list shipped with the plugin
- runs your old and new models on your own prompts and compares cost, truncation, invalid JSON and score drift
- makes the code changes only after you approve them

## Install

```sh
claude plugin marketplace add halilturkoglucs/model-migrate
claude plugin install model-migrate@model-migrate
```

Requires Node.js 20 or later. The plugin has no npm dependencies.

## Use

In Claude Code:

```
/model-migrate:migrate
```

Or run the CLI directly, which is on the Bash tool's PATH while the plugin is enabled:

```sh
model-migrate scan .
model-migrate status . --within 90
model-migrate status . --fail
model-migrate compare compare.json --yes
```

`status --fail` exits 1 when a retired, urgent or missing model is used outside tests and docs, so it can run in CI. It also exits 1 when a provider's data cannot be read.

`no-date` means no shutdown was found. It does not guarantee a model is safe.

Set `OPENAI_API_KEY` to use OpenAI's `shutdown_date` field and detect models your key cannot see. Other sources need no key.

## Compare config

The first model is the baseline. Prices are USD per 1M tokens, taken from the provider's pricing page.

```json
{
  "models": [
    { "id": "old-model", "provider": "openai", "price": { "input": 0.2, "cachedInput": 0.02, "output": 1.25 } },
    { "id": "new-model", "provider": "openai", "params": { "reasoning": { "effort": "none" } }, "price": { "input": 0.1, "output": 0.5 } }
  ],
  "cases": [{ "name": "strong answer", "instructions": "You grade essays.", "input": "..." }],
  "runs": 2,
  "maxOutputTokens": 700,
  "schema": { "type": "object", "additionalProperties": false, "required": ["score"], "properties": { "score": { "type": "integer" } } },
  "scorePath": "score",
  "scoreTolerance": 5
}
```

Verdicts: `FAIL` means errors, truncation or invalid JSON. `REVIEW` means a case moved more than `scoreTolerance` from the baseline.

## Privacy and limits

- `scan` works locally. For `.env` files it reports only the variable name, never the value.
- `status` fetches public provider pages and sends your key only to OpenAI's models endpoint.
- `compare` sends your test cases to the providers you list and makes paid calls. It does nothing without `--yes`.
- `compare` covers text generation only.
- The scan finds model IDs written literally. It cannot see values set only in your deployment settings or assembled at runtime.
- `compare` is tested live against OpenAI. Anthropic and Gemini `compare` support is experimental: it has only run against mocked responses.

MIT licensed.
