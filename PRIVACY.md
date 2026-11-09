# Privacy

Model Migrate has no server of its own and contains only instructions for Claude. The author does not receive, collect or store your code, prompts, API keys or usage data.

The skill asks Claude to read source files in your project and to skip real `.env` files. Claude Code handles that content under the terms of your Claude plan.

What else leaves your machine:

| Action | Sent to | Data |
|---|---|---|
| Checking shutdown dates | `developers.openai.com`, `platform.claude.com`, `ai.google.dev` | Ordinary page requests, with no code or keys |
| Comparing models, after you approve | The providers you choose | Your test cases and that provider's key |

Those providers handle that data under their own terms and privacy policies. Use synthetic test cases unless you are allowed to send real data to them.

The plugin stores nothing.

Questions: open an issue at https://github.com/halilturkoglucs/model-migrate/issues
