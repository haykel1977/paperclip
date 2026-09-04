---
title: HTTP Adapter
summary: HTTP webhook adapter
---

The `http` adapter sends a webhook request to an external agent service. The agent runs externally and Paperclip just triggers it.

## When to Use

- Agent runs as an external service (cloud function, dedicated server)
- Fire-and-forget invocation model
- Integration with third-party agent platforms

## When Not to Use

- If the agent runs locally on the same machine (use `process`, `claude_local`, or `codex_local`)
- If you need stdout capture and real-time run viewing

## Configuration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | Yes | Webhook URL to POST to. Must be `http:` or `https:`. Private, loopback, link-local, and metadata addresses are blocked unless the hostname is listed in `PAPERCLIP_HTTP_ADAPTER_ALLOWED_HOSTS`. |
| `headers` | object | No | Additional HTTP headers |
| `timeoutSec` | number | No | Request timeout |

## SSRF guard

The server resolves the configured URL and pins the TCP connect to that
address so a later DNS answer cannot retarget the request (rebinding).
The original hostname is still sent as `Host` / SNI. It rejects:

- non-`http`/`https` schemes
- `localhost`, `*.localhost`, and cloud metadata hostnames
- literal private / loopback / link-local / CGNAT / unique-local IPs
- DNS answers that resolve to those address ranges
- HTTP redirects (`redirect: "manual"`). A public URL that 30x's to localhost,
  RFC1918, or metadata is refused instead of being followed

Operators who intentionally invoke an internal webhook can set
`PAPERCLIP_HTTP_ADAPTER_ALLOWED_HOSTS=hooks.internal.example` (comma-separated exact hostnames).
The allowlist is fail-closed: unset means no private targets. The allowlist
does not authorize following redirects.

Environment-test HEAD probes use the same guard, so a blocked URL or a redirect
fails the adapter test (`http_url_ssrf_blocked`) instead of probing the internal
network or warning as a connectivity miss.

## How It Works

1. Paperclip validates the URL (SSRF guard), then sends a POST request to the configured URL
2. The request body includes the execution context (agent ID, task info, wake reason)
3. The external agent processes the request and calls back to the Paperclip API
4. Response from the webhook is captured as the run result

## Request Body

The webhook receives a JSON payload with:

```json
{
  "runId": "...",
  "agentId": "...",
  "companyId": "...",
  "context": {
    "taskId": "...",
    "wakeReason": "...",
    "commentId": "..."
  }
}
```

The external agent uses `PAPERCLIP_API_URL` and an API key to call back to Paperclip.
