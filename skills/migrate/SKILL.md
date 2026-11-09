---
name: migrate
description: Find AI model IDs in a codebase, check live shutdown dates, compare cost and output on the project's own prompts, and migrate safely. Use for model deprecation, model shutdown or retirement, upgrading or swapping an OpenAI, Anthropic or Gemini model, "is my model being retired", or finding a cheaper model.
---

# Migrate AI models

Replacing a model ID is the easy part. A listed replacement can use a different endpoint, reject parameters, spend output tokens on reasoning, cost more, or change the output your product depends on. Check those before editing anything.

Provider data goes stale fast. Never rely on remembered model names, dates or prices. Use only pages read in this session.

## 1. Inventory

Search the project for model IDs, from the project root:

```sh
grep -rnEI --exclude-dir={.git,node_modules,.next,.vercel,dist,build,coverage,vendor} --exclude='.env' --exclude='.env.*' --exclude='*lock*' 'gpt-[0-9]|gpt-(image|audio|realtime|transcribe|live)|chatgpt-|text-embedding-|whisper-1|tts-1|dall-e-|omni-moderation-|claude-[a-z0-9-]*[0-9]|gemini-[0-9]' .
```

Also search for the short OpenAI names in quotes: `"o1`, `"o3`, `"o4`, and the same with single quotes and backticks.

Never open real `.env` files, because they hold secrets. Committed templates such as `.env.example` are fine.

Sort each hit into one of these:

- **runtime**: application code that calls a model. These must migrate.
- **script**: generation or maintenance scripts.
- **test, doc or generated**: update them last.
- **env-override**: the model is read from an environment variable, and the ID is only a default.
- **cost branch**: price tables or conditions keyed on model names.
- **feature branch**: conditions that enable parameters per model.

For each file with a hit, note the endpoint it calls (for example Responses, Chat Completions, Messages, generateContent, audio, realtime, embeddings) and the parameters it sends.

The search finds IDs written literally. It cannot see values set only in deployment settings or assembled at runtime. Ask the user which model production really uses if you cannot check. Never print secret values.

## 2. Check shutdown dates

Read each provider's current page:

- OpenAI: https://developers.openai.com/api/docs/deprecations.md
- Anthropic: https://platform.claude.com/docs/en/about-claude/model-deprecations.md
- Gemini: https://ai.google.dev/gemini-api/docs/deprecations.md.txt

Report one row per model: model, provider, where it is used, shutdown date, listed replacement, state.

- A code alias may appear on the page only as dated snapshots. Match the alias to its newest snapshot and say you did so.
- Gemini dates are the earliest possible shutdown, so report them as "not before".
- If a model is not on the page, its state is "no date found". That does not mean it is safe.
- If a page cannot be read, say so and do not treat that provider's models as safe.

## 3. Check the replacement really fits

For each model to migrate, read the provider's current model, pricing and endpoint pages. Check, for each file from step 1:

- Does the replacement support this endpoint? A listed replacement may need a different API.
- Are the parameters in use still accepted (`temperature`, `max_tokens`, `reasoning`, schema options)?
- Does it reason by default? Reasoning tokens count against output limits and can truncate responses.
- What does it cost per unit, and is the unit the same (tokens, minutes, characters)?
- Does it have its own shutdown date?

If the user wants a cheaper option, list the alternatives that have no near shutdown, with prices from the pricing page.

## 4. Compare on the project's own prompts

Before changing a default, test the candidate against the current model:

1. Use the project's real instructions, output limit and schema.
2. Use synthetic inputs. Do not use real customer data unless the user explicitly approves it.
3. Include weak, typical and strong inputs, because drift can appear at only one end.
4. Run each case at least twice on each model.
5. Record cost, latency, truncation, invalid JSON and score drift against the current model.

Comparison makes paid calls and sends every case to the provider. State the number of calls and the providers, and get the user's approval first. Use the project's existing test setup, or write a small script for the user to run in their own terminal. Never ask the user to paste a key into the chat.

For audio, embeddings or images, use a round-trip test. For example, generate speech and transcribe it back, then compare the words to the source text.

Show the user a table and explain anything that failed or moved. Small samples give weak evidence, so say how many cases ran. Let the user choose the model.

## 5. Apply after approval

Change only what the user approved:

- Update default model IDs, env examples and hard-coded references.
- Update every cost branch. Cost code keyed on model names often returns 0 for an unlisted model, which hides spend.
- Update feature branches.
- Adjust parameters and output limits found in step 3.
- If the endpoint changes, rewrite that call and test it end to end.
- If production overrides a model through an environment variable, tell the user which setting to change.

## 6. Verify and report

Run the project's type checks, tests and build. Repeat the search from step 1 to confirm no old ID remains.

Do not commit, push or deploy unless the user asks. Report what changed, test results, cost change and output drift, and anything not tested.
