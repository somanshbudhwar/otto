# Otto

A local-first, bring-your-own-key agentic coding workspace. Desktop app, no backend.

Otto is an independent take on the ideas behind Augment Code's Intent: each task gets its own
**git worktree**, an agent works inside it with real file and shell tools, and you review the
result as a **diff** before anything touches your branch. The difference is that Otto runs
entirely on your machine against **your own API keys**, so it keeps working regardless of any
vendor's roadmap.

<!-- Add a screenshot here once you've run it: docs/screenshot.png -->

## Why

Hosted agent workspaces are convenient right up until they're sunset, repriced, or rate-limited.
Otto keeps the parts that matter — worktree isolation, a real tool-using agent, a reviewable
diff — and puts the model choice in your hands:

| | |
|---|---|
| **Your keys** | Anthropic, OpenAI, Google Gemini, or any OpenAI-compatible endpoint |
| **Your machine** | No Otto server exists. Keys go to the provider you picked, nowhere else |
| **Your repo** | Agents work on an isolated worktree; your checkout is never touched |

## Features

- **Multi-provider, bring-your-own-key.** Anthropic, OpenAI, Google Gemini, and any
  OpenAI-compatible server (Ollama, LM Studio, vLLM, OpenRouter, Groq, DeepSeek).
- **Pick the exact model per task.** Built-in catalog plus a *Refresh from API* button that
  queries the provider's live `/models` endpoint, so new releases appear without an app update.
- **Reasoning controls.** Adaptive thinking and a `low → max` effort dial where the model
  supports it, with optional streaming reasoning summaries.
- **Worktree isolation.** Every task is a real `git worktree` on its own `otto/*` branch.
  Run several in parallel without collisions.
- **Real tools.** `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, and `bash` —
  all sandboxed to the workspace root.
- **Live diff panel.** Committed, staged, unstaged, and untracked changes against the commit the
  task branched from. Commit from the app when it looks right.
- **Shell commands are gated by default.** Every `bash` call prompts for approval until you turn
  that off.
- **Encrypted key storage** via Electron `safeStorage` (OS keychain).

## Install

Requires **Node 20+** and **git**.

```bash
git clone https://github.com/somanshbudhwar/otto.git
cd otto
npm install
npm run dev
```

To produce a distributable app:

```bash
npm run dist:mac     # or dist:win / dist:linux
```

## First run

1. **Settings → add an API key** for at least one provider, then hit **Test & refresh models**.
   That performs a real authenticated call, so it doubles as a credential check.
   - For an OpenAI-compatible server, set the **Base URL** instead (e.g. `http://localhost:11434/v1`).
     Local servers usually need no key.
2. **Add project** — pick a git repository. It needs at least one commit, since Otto branches from `HEAD`.
3. **+** next to the project — create a task. This makes a worktree and an `otto/<slug>` branch.
4. Pick a model in the header bar, describe the change, and press Enter.
5. Review the **Changes** panel, then **Commit**.

Deleting a task removes its worktree and branch. Your repository and your own working tree are
never modified by Otto itself — only by the agent, inside its worktree.

## How it works

```
Electron main process                      Renderer (React)
├── providers/                             ├── Sidebar: projects → tasks
│   ├── anthropic.ts   Messages API        ├── Transcript: streamed text,
│   ├── openai.ts      Chat Completions    │   reasoning, tool cards
│   │                  (also compatible)   └── Diff panel: per-file hunks
│   └── google.ts      generateContent
├── agent/
│   ├── loop.ts        tool-call loop
│   └── tools.ts       sandboxed tools
└── core/
    ├── git.ts         worktrees + diff
    └── store.ts       state + safeStorage
```

Each provider adapter translates a single canonical message format to and from its own wire
shape, and emits the same stream events, so the agent loop is provider-agnostic. Provider
quirks are handled in the adapters rather than leaking outward — for example, Anthropic thinking
blocks are replayed byte-identical on the next turn, and Gemini's function declarations get a
sanitized OpenAPI-flavoured schema.

## Security notes

- API keys are encrypted with your OS keychain. If encryption is unavailable, Otto says so
  in Settings rather than silently storing plaintext.
- Every filesystem tool resolves its path and **refuses anything that escapes the workspace root**.
- `bash` is *not* sandboxed beyond its working directory — a command can still reach the network
  or other files on your machine. That is why approval is on by default; think before enabling
  auto-approve on repos you don't trust.

## Roadmap

v1 is the agent core. Next up, following Intent's shape:

- Living **spec** per workspace that the agent reads from and updates
- **Coordinator → implementor → verifier** multi-agent orchestration in waves
- PR creation and review flow, plus a browser preview pane
- Prompt caching to cut cost on long sessions
- Checkpoint / rewind within a task

## License

MIT
