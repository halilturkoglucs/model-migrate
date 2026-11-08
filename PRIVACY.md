# Privacy

Model Migrate has no server of its own. The author does not receive, collect or store your code, prompts, API keys or usage data.

What the plugin does on your machine:

- **Scanning** reads source files in the directory you choose and keeps the results local. Real `.env` files are skipped. Committed templates such as `.env.example` are read, and only the variable name is reported.
- **API keys** are optional and are entered through Claude Code's plugin settings, which keep them in your system's secure credential store. The plugin does not read credentials already set in your environment.

What leaves your machine:

| Action | Sent to | Data |
|---|---|---|
| Checking shutdown dates | `developers.openai.com`, `platform.claude.com`, `ai.google.dev` | Ordinary page requests, with no code or keys |
| Checking shutdown dates with an OpenAI key configured | `api.openai.com` | Your OpenAI key, to list models |
| Comparing models, after you confirm | The providers you list: `api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com` | Your test cases and that provider's key |

Those providers handle that data under their own terms and privacy policies. Use synthetic test cases unless you are allowed to send real data to them.

The plugin keeps no data after it exits, apart from the configuration you enter in Claude Code.

Questions: open an issue at https://github.com/halilturkoglucs/model-migrate/issues
