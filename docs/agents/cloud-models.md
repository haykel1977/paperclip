# Cloud models opt-in

By default Paperclip refuses any agent model whose id or label does not contain
`sovereign` or `souverain`. The validator lives in
`server/src/routes/agents.ts::assertSovereignAgentModel` and is called on every
create / update path.

That default exists to protect operators who run Paperclip against an on-prem
gateway (Bifrost, LiteLLM, vLLM, TGI, ...) and do not want a stray PATCH to
silently pipe traffic to a paid third-party API.

## Turning it off

Set `PAPERCLIP_ALLOW_CLOUD_MODELS=1` in the server environment. When the flag
is enabled:

- `POST /api/companies/:companyId/agents` and `PATCH /api/agents/:id` accept
  any adapter model id (the sovereign-only check is skipped).
- Runtime execution: `assertSovereignRuntimeModel` in
  `server/src/services/heartbeat.ts` also becomes a no-op, so agents saved
  with a cloud model actually run.
- Model profile merging (`applyRuntimeModelProfile`,
  `mergeModelProfileAdapterConfig`) and company portability import stop
  dropping non-sovereign models.
- Plugin-managed agent declarations accept cloud models too.
- `GET /api/companies/:id/adapters/:type/models` returns the full adapter
  catalog (Anthropic, OpenAI, Moonshot, DeepSeek, Z.AI, ...) instead of the
  sovereign-filtered subset.
- `GET .../model-profiles` and `GET .../detect-model` behave the same way.

The flag is checked on every request, so toggling it on Vercel and redeploying
takes effect immediately - no code change required.

## When to use it

Use it when you have deliberately decided to mix cloud adapters with (or
instead of) your sovereign gateway. Typical trigger: you want Sonnet on the
Engineer role, GPT-5 as maker/checker on Release Manager, Kimi K2.7 Code on
QA-Tests, while keeping Qwen3 sovereign on high-volume implementers.

Do not use it as a permanent default in a sovereign-first deployment. The
recommended pattern is:

1. Flag off during normal operation.
2. Flag on for a controlled window when you PATCH the agent fleet.
3. Flag off again once every agent's `adapterConfig.model` is on the intended
   value. Existing agents keep working even if the flag flips back off - the
   validator only runs on writes.

## Related environment flags

- `PAPERCLIP_ENABLE_NOOP_DONE_AUTO_DISPOSITION=1` - opt-in for the recovery
  handoff fix (PR #98).

Both flags follow the same pattern: opt-in, default off, no schema migration.

## Permanent cloud mode (development deployment)

The development deployment described in [Development cloud deployment](/deploy/dev-cloud-opencode-go) keeps `PAPERCLIP_ALLOW_CLOUD_MODELS=1` permanently. This is not the short window recommended above. It is a declared deviation.

Why the flag stays at 1 there:

- Four agents (`Q-Gov`, `Q-Impl`, `Q-Web`, `QA-Tests`) run on `opencode-go/*` models. The runtime guard `assertSovereignRuntimeModel` runs before every heartbeat. With the flag off, every one of their runs fails. The flag therefore has to stay at 1 as long as those agents are on cloud models.
- The decision is the operator's, for the duration of the Quantum development phase, with a conditional expiry (2026-12-02 unless re-signed) and early-termination conditions. It is written down in [ADR-IA-018](/adr/ADR-IA-018-mode-cloud-rnd): dev-only scope, exact provider and models, what leaves the host and to whom, compensating controls, expiry and re-evaluation date, return procedure. Until the operator signs that ADR, the deviation is not covered by anything.

What this page says remains true: do not use this flag as a permanent default in a sovereign-first deployment. The development deployment above does exactly what this advice warns against. It does so in the open, with an expiry.

Reading correction, without erasing the original text: the sentence "Existing agents keep working even if the flag flips back off" is not accurate as of the merge of PR #100 (commit `ca53c5f`), which introduces this sentence and, in the same commit, the runtime guard `assertSovereignRuntimeModel` called before every run (`server/src/services/heartbeat.ts`). An agent stored with a cloud model stops running as soon as the flag goes back to 0. That is the intended fail-closed behaviour, and it is also why the return-to-sovereign procedure changes the model before switching the flag off. The function named `applyRuntimeModelProfile` earlier on this page is called `resolveModelProfileApplication` in the code.
