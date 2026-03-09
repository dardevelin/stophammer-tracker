# stophammer-tracker

Optional Cloudflare Workers peer tracker for the
[stophammer](https://github.com/dardevelin/stophammer) network.

Provides a lightweight node registry so new community nodes can bootstrap peer
discovery before they know the primary URL. Once a node knows the primary, it no
longer needs the tracker — the primary itself serves `GET /sync/peers`.

## Status

The tracker is **optional**. The stophammer primary node is its own tracker via
`GET /sync/peers`. This Cloudflare Worker is only needed as an external bootstrap
for nodes that don't yet know the primary URL.

## API

| Route | Description |
|---|---|
| `POST /nodes/register` | Register or update a node — body: `{ pubkey, address }` |
| `GET /nodes/find` | Return nodes seen within the last 10 minutes |
| `GET /health` | Liveness check |

Nodes not seen within 1 hour are evicted from storage automatically.

## Requirements

- [Node.js](https://nodejs.org) or [Bun](https://bun.sh)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- A Cloudflare account with Workers and Durable Objects enabled

## Deployment

```bash
npm install
npx wrangler deploy
```

On first deploy, Wrangler applies the `v1` migration that creates the `NodeRegistry`
Durable Object class. No additional configuration or KV namespaces are required —
the DO owns its own storage.

## Local development

```bash
npm run dev
# Worker available at http://localhost:8787
```

## Example requests

```bash
# Register a node
curl -X POST https://your-tracker.workers.dev/nodes/register \
  -H "Content-Type: application/json" \
  -d '{"pubkey":"0805c402...","address":"https://my-node.example.com"}'

# Find active nodes
curl https://your-tracker.workers.dev/nodes/find
```

## License

AGPL-3.0-only — see [LICENSE](LICENSE).
