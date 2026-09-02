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
