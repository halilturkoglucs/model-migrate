---
name: migrate
description: Find AI model IDs in a codebase, check live shutdown dates, compare cost and output on the project's own prompts, and migrate safely. Use for model deprecation, model shutdown or retirement, upgrading or swapping an OpenAI, Anthropic or Gemini model, "is my model being retired", or finding a cheaper model.
---

# Migrate AI models

Replacing a model ID is the easy part. A listed replacement can use a different endpoint, reject parameters, spend output tokens on reasoning, cost more, or change the output your product depends on. Check those before editing anything.

Provider data goes stale fast. Never rely on remembered model names, dates or prices. Use `model-migrate` output and pages read in this session.

## 1. Inventory

Run from the project root:

```sh
model-migrate scan . --json
model-migrate status . --within 90
```

Report the status table. `no-date` means no shutdown was found, not that the model is safe. If a source fails, say so and do not treat its models as safe.

Check which model production really uses. Tagged `env-override` lines may be overridden in deployment settings, which the scan cannot see. Ask the user if you cannot check. Never print secret values.

## 2. Check the replacement really fits

For each model to migrate, read the provider's current model, pricing and endpoint pages. Check, for each file in the scan's API surface:

- Does the replacement support this endpoint? A listed replacement may need a different API.
- Are the parameters in use still accepted (`temperature`, `max_tokens`, `reasoning`, schema options)?
- Does it reason by default? Reasoning tokens count against output limits and can truncate responses.
- What does it cost per unit, and is the unit the same (tokens, minutes, characters)?
- Does it have its own shutdown date?

If the user wants a cheaper option, list the alternatives that have no near shutdown, with prices from the pricing page.

## 3. Compare on the project's own prompts

Build a config from the project's real instructions and representative synthetic inputs. Do not use real customer data unless the user explicitly approves it.

`compare` makes paid calls and sends every case to the providers named. State the call count and providers, and get the user's approval before passing `--yes`.

```json
{
  "models": [
    { "id": "CURRENT_MODEL", "provider": "openai", "price": { "input": 0, "cachedInput": 0, "output": 0 } },
    { "id": "CANDIDATE_MODEL", "provider": "openai", "params": {}, "price": { "input": 0, "output": 0 } }
  ],
  "cases": [{ "name": "strong answer", "instructions": "SYSTEM PROMPT", "input": "USER INPUT" }],
  "runs": 2,
  "maxOutputTokens": 700,
  "schema": { "type": "object", "additionalProperties": false, "required": ["score"], "properties": { "score": { "type": "integer" } } },
  "scorePath": "score",
  "scoreTolerance": 5
}
```

The first model is the baseline. Prices are USD per 1M tokens from the pricing page. Use the project's real output limit and schema, and omit `schema` and `scorePath` when they do not apply. Include weak, typical and strong inputs, because drift can appear at only one end.

```sh
model-migrate compare compare.json --yes
```

`compare` covers text generation only. Anthropic and Gemini support is experimental, so tell the user and check any provider error against current docs. For audio, embeddings or images, write a small round-trip test instead. For example, generate speech and transcribe it back, then compare the words to the source text.

Show the user the table and explain any `FAIL` or `REVIEW`. Small samples give weak evidence, so say how many cases ran. Let the user choose the model.

## 4. Apply after approval

Change only what the user approved:

- Update default model IDs, env examples and hard-coded references.
- Update every `cost-branch` line. Cost code keyed on model names often returns 0 for an unlisted model, which hides spend.
- Update other `branch` lines that enable features per model.
- Adjust parameters and output limits found in step 2.
- If the endpoint changes, rewrite that call and test it end to end.
- If production overrides a model through env, tell the user which setting to change.

## 5. Verify and report

Run the project's type checks, tests and build. Run `model-migrate status .` again.

Do not commit, push or deploy unless the user asks. Report what changed, test results, cost change and output drift, and anything not tested.
