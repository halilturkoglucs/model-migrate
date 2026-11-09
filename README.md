# Model Migrate

Replace AI models before they break production, and find out what the new model changes first.

Replacing a model ID is the easy part. A listed replacement can use a different endpoint, reject your parameters, spend your output limit on reasoning, cost more, or change the results your product depends on.

Model Migrate is a Claude Code plugin with one skill. It guides Claude to:

- find OpenAI, Anthropic and Gemini model IDs in your code
- flag env overrides, and cost code that silently breaks on an unlisted model
- check shutdown dates on each provider's current page, not a list shipped with the plugin
- compare your old and new models on your own prompts for cost, truncation, invalid JSON and score drift
- make the code changes only after you approve them

## Install

```sh
claude plugin marketplace add halilturkoglucs/model-migrate
claude plugin install model-migrate@model-migrate
```

## Use

In Claude Code:

```
/model-migrate:migrate
```

Example prompts:

1. "Which AI models in this repo are shutting down in the next 90 days?"
2. "Compare our current grading model with its replacement and show cost and score drift."
3. "Our Claude model is being retired. Migrate this project, but show me what changes before you edit anything."

## Full edition

This edition contains instructions only, and runs no code of its own. The [`full` branch](https://github.com/halilturkoglucs/model-migrate/tree/full) adds a scanner CLI, a CI check, and a `compare` tool that runs the model comparison for you. It needs Node.js 20 or later:

```sh
claude plugin marketplace add halilturkoglucs/model-migrate#full
claude plugin install model-migrate@model-migrate
```

## Limits

- The search finds model IDs written literally. It cannot see values set only in deployment settings or assembled at runtime.
- "No date found" means no shutdown was found. It does not guarantee a model is safe.
- Comparisons make paid calls to your providers, and only run after you approve them.

See [PRIVACY.md](PRIVACY.md) for what is sent where.

MIT licensed.
