import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "cursor";
export const label = "Cursor CLI (local)";

// Cursor CLI is not distributed as an npm package — the official install
// path is the upstream installer script at cursor.com/install. Other adapters
// in this repo prefer `npm install -g <pkg>` which is content-addressed by the
// registry; cursor must use `curl | bash` until upstream publishes a registry
// artifact. Pinning a commit/version here would require shipping our own
// mirror of the installer; revisit if Cursor adds an npm/release-asset
// equivalent.
export const SANDBOX_INSTALL_COMMAND = "curl https://cursor.com/install -fsS | bash";

const CURSOR_FALLBACK_MODEL_IDS = [
  "sovereign-auto",

  "sovereign-composer-1.5",
  "sovereign-composer-1",
  "sovereign-gpt-5.3-codex-low",
  "sovereign-gpt-5.3-codex-low-fast",
  "sovereign-gpt-5.3-codex",
  "sovereign-gpt-5.3-codex-fast",
  "sovereign-gpt-5.3-codex-high",
  "sovereign-gpt-5.3-codex-high-fast",
  "sovereign-gpt-5.3-codex-xhigh",
  "sovereign-gpt-5.3-codex-xhigh-fast",
  "sovereign-gpt-5.3-codex-spark-preview",
  "sovereign-gpt-5.2",
  "sovereign-gpt-5.2-codex-low",
  "sovereign-gpt-5.2-codex-low-fast",
  "sovereign-gpt-5.2-codex",
  "sovereign-gpt-5.2-codex-fast",
  "sovereign-gpt-5.2-codex-high",
  "sovereign-gpt-5.2-codex-high-fast",
  "sovereign-gpt-5.2-codex-xhigh",
  "sovereign-gpt-5.2-codex-xhigh-fast",
  "sovereign-gpt-5.1-codex-max",
  "sovereign-gpt-5.1-codex-max-high",
  "sovereign-gpt-5.2-high",
  "sovereign-gpt-5.1-high",
  "sovereign-gpt-5.1-codex-mini",
  "sovereign-opus-4.6-thinking",
  "sovereign-opus-4.6",
  "sovereign-opus-4.5",
  "sovereign-opus-4.5-thinking",
  "sovereign-sonnet-4.6",
  "sovereign-sonnet-4.6-thinking",
  "sovereign-sonnet-4.5",
  "sovereign-sonnet-4.5-thinking",
  "sovereign-gemini-3.1-pro",
  "sovereign-gemini-3-pro",
  "sovereign-gemini-3-flash",
  "sovereign-grok",
  "sovereign-kimi-k2.5",
];

export const models = CURSOR_FALLBACK_MODEL_IDS.map((id) => ({ id, label: id }));

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Preserve the agent's sovereign primary model for the cheap lane until a sovereign budget model is configured.",
    adapterConfig: {},
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# cursor agent configuration

Adapter: cursor

Use when:
- You want Paperclip to run Cursor Agent CLI locally as the agent runtime
- You want Cursor chat session resume across heartbeats via --resume
- You want structured stream output in run logs via --output-format stream-json

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- Cursor Agent CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, required): sovereign Cursor model id or label containing "sovereign" or "souverain"
- mode (string, optional): Cursor execution mode passed as --mode (plan|ask). Leave unset for normal autonomous runs.

- command (string, optional): defaults to "agent"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs are executed with: agent -p --output-format stream-json ...
- Prompts are piped to Cursor via stdin.
- Sessions are resumed with --resume when stored session cwd matches current cwd.
- Paperclip auto-injects local skills into "~/.cursor/skills" when missing, so Cursor can discover "$paperclip" and related skills on local runs.
- Paperclip auto-adds --yolo unless one of --trust/--yolo/-f is already present in extraArgs.
- Remote sandbox runs prepend "~/.cursor/bin" and "~/.local/bin" to PATH and prefer the installed absolute entrypoint from one of those directories when the default Cursor command is requested, so installer-managed sandbox leases do not need hardcoded command paths.
`;
