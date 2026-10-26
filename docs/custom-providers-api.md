# Custom OpenAI-compatible providers

API clients can register multiple named OpenAI-compatible connections, discover their models, and select those models through the existing settings and chat APIs. No UI configuration is required.

Connections use **Chat Completions**. Supply the API root as `baseUrl`, including `/v1` when required by the upstream server. For example, `http://localhost:11434/v1` discovers models at `/v1/models` and sends inference requests to `/v1/chat/completions`. URLs must use HTTP or HTTPS and cannot contain credentials, query parameters, or fragments. Localhost addresses refer to the LearnHarness server's host.

The existing API access controls apply. These examples target a web server deployment; packaged desktop mode still requires its desktop API capability.

## Endpoints

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/api/providers` | List custom connections. |
| `POST` | `/api/providers` | Create a connection and discover models; returns `201`. |
| `GET` | `/api/providers/:id` | Read one connection and its saved models. |
| `PUT` | `/api/providers/:id` | Update a connection and rediscover models. |
| `DELETE` | `/api/providers/:id` | Remove a connection and its credentials. |
| `POST` | `/api/providers/:id/refresh` | Rediscover models using the saved configuration. |

`POST` and `PUT` accept `name`, `baseUrl`, and an optional `apiKey`. Both require `name` and `baseUrl`. On update, omitting `apiKey` preserves the saved key; `null` or an empty string removes it. Omit the key for a server that needs no authentication. Connections receive server-generated IDs beginning with `custom-`, keeping their models separate from built-in providers.

```bash
lh_api='http://localhost:3000'

curl -X POST "$lh_api/api/providers" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "My inference server",
    "baseUrl": "https://inference.example.com/v1",
    "apiKey": "your-upstream-key"
  }'
```

The response contains connection metadata and discovered models, never the API key:

```json
{
  "provider": {
    "id": "custom-79a73179-78ae-4f73-bd14-6a1439f74bf7",
    "name": "My inference server",
    "baseUrl": "https://inference.example.com/v1",
    "apiKeyPresent": true,
    "pricingKnown": false,
    "models": [
      {
        "id": "my-model",
        "name": "my-model",
        "contextWindow": 32768,
        "maxTokens": 4096,
        "input": ["text"],
        "reasoning": true
      }
    ]
  }
}
```

`GET /api/providers` wraps the same connection objects in `{"providers": [...]}`. Use the returned ID in subsequent requests:

```bash
custom_provider_id='custom-79a73179-78ae-4f73-bd14-6a1439f74bf7'

curl "$lh_api/api/providers"
curl "$lh_api/api/providers/$custom_provider_id"
curl -X POST "$lh_api/api/providers/$custom_provider_id/refresh"

# Change the endpoint or name while retaining the existing key.
curl -X PUT "$lh_api/api/providers/$custom_provider_id" \
  -H 'Content-Type: application/json' \
  -d '{"name":"My inference server","baseUrl":"https://new-inference.example.com/v1"}'

curl -X DELETE "$lh_api/api/providers/$custom_provider_id"
```

## Discovery and model selection

Discovery reads the upstream OpenAI-style `{"data": [{"id": "my-model"}]}` response. Models become available immediately in `GET /api/models` and in the existing model settings validation. Refresh is explicit: reading a saved custom catalog does not contact its upstream server.

Context discovery uses the first valid positive integer from `contextWindow`,
`context_length`, `top_provider.context_length`, and `meta.n_ctx` in each model
entry. For llama.cpp servers, `meta.n_ctx` describes the configured
context per request/slot. `meta.n_ctx_train` is the model's training maximum and
is not used as the serving limit.

For a single-model catalog missing context or modality metadata, discovery also
checks the server's `/props` endpoint once. A base URL ending in `/v1` uses
`/props` beside that suffix, preserving earlier path prefixes (`/api/v1` becomes
`/api/props`). The probe uses the connection's credentials and the same discovery
timeout; cancelling the request prevents saving its results.

If context metadata is missing, a valid `default_generation_settings.n_ctx`
supplies the configured context window. For example, a server reporting `102400`
produces a 102,400-token context window (102.4K). If modality metadata is missing
and `modalities.vision` is `true`, the saved model includes
`input: ["text", "image"]`, making it available in the Vision pickers and enabling
image input during inference. Explicit context and modality metadata remain
authoritative. Catalogs with multiple models do not use this server-wide
fallback. An unavailable or invalid `/props` response leaves existing metadata
and the defaults for missing fields intact. Maximum output is capped at the
final discovered context window.

After redeploying the updated LearnHarness server, use **Refresh Models** on an
existing endpoint to update its saved context and vision capabilities, then
select it for Vision if needed. Reading the catalog does not refresh it or
change any model slot selections.

Custom Endpoint mode applies a fixed reasoning policy to every model: **medium**
and **xhigh** are the only choices, and **xhigh** is the default. This policy
does not depend on upstream reasoning metadata or `/props`. The model catalog
advertises `supportedLevels: ["medium", "xhigh"]`, and inference sends the selected
value as `reasoning_effort` for OpenAI-compatible endpoints. An explicit medium
selection is preserved. Off is unavailable; custom inference always uses one
of the two supported values.

When model metadata is absent, the approved defaults are:

| Property | Fallback |
| --- | --- |
| Context window | 32,768 tokens |
| Maximum output | 4,096 tokens, capped at the context window |
| Input | Text only, unless a single-model server confirms vision through `/props` |
| Reasoning | Enabled; medium or xhigh, default xhigh |
| Pricing | Unknown |

These limits are fallbacks, not guarantees about the upstream model. Discovery cannot verify tool calling or streaming support; the upstream Chat Completions endpoint must support the features needed by the selected agent.

```bash
curl "$lh_api/api/models"

# Set defaults for new conversations and background roles using this model.
curl -X PUT "$lh_api/api/settings/models" \
  -H 'Content-Type: application/json' \
  -d '{
    "strong": {"model": {"provider": "custom-79a73179-78ae-4f73-bd14-6a1439f74bf7", "id": "my-model"}},
    "cheap": {"model": {"provider": "custom-79a73179-78ae-4f73-bd14-6a1439f74bf7", "id": "my-model"}}
  }'

# Select a model for an existing conversation.
chat_id='your-chat-id'
curl -X PUT "$lh_api/api/chats/$chat_id/settings" \
  -H 'Content-Type: application/json' \
  -d '{"model":{"provider":"custom-79a73179-78ae-4f73-bd14-6a1439f74bf7","id":"my-model"}}'
```

The `models` settings write replaces the entire models section. Include every slot you want to retain; `vision` uses the same `{"model":{"provider":"...","id":"..."}}` shape and should select a model whose discovered `input` includes `image`. Changing the `strong` default affects new conversations. Existing conversations use their own settings.

Custom model entries carry `pricingKnown: false` in `/api/models`. Their numeric `cost` fields remain zero placeholders for compatibility with the existing catalog contract; clients must check `pricingKnown` and display the price as unknown. Those zeros do not mean the upstream service is free. Session and job accounting also treats custom model prices as unknown.

## Persistence and failures

Connections, credentials, and discovered catalogs persist across server restarts in `custom-providers.json` under `LH_DATA_DIR` (the normal `data/` directory when unset). The file uses mode `0600` and contains secrets; API responses expose only `apiKeyPresent`.

Discovery completes before a create, update, or refresh is saved. A failed discovery leaves an existing connection and its catalog unchanged. Concurrent changes are rejected rather than restoring a deleted connection or overwriting a newer update. Deleting a provider removes it from the model catalog; existing chat or slot references must be changed to a remaining provider before use.

Errors use `{"error": "..."}`:

| Status | Meaning |
| --- | --- |
| `400` | Invalid JSON or connection configuration. |
| `404` | Custom connection not found. |
| `409` | Connection changed while discovery was running; read it again before retrying. |
| `502` | Upstream discovery failed or returned an invalid model list. |
| `504` | Upstream discovery timed out. |
