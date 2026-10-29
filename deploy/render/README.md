# Production (free): Render + Aiven Kafka

```
RestroFlow ──HTTPS──▶ Render free web service ──TLS──▶ Aiven Kafka (free)
                      (services/edge: ingest + analytics + dashboard, one container)
```

Cost: €0. Trade-offs of the free plans:

- **Sleeps after 15 min without traffic.** The first request afterwards takes about a minute. A webhook that arrives meanwhile fails once and RestroFlow retries it (1, 5, 30, 120, 360 min) – nothing is lost or double-counted.
- **No disk.** Statistics live in memory and are rebuilt from Kafka on every start (`REPLAY_ON_START=true`), as far back as the Aiven topic retention allows.

The infrastructure is defined in [`render.yaml`](../../render.yaml). Render deploys automatically once GitHub CI is green (`autoDeployTrigger: checksPass`).

## 1. Aiven Kafka

1. console.aiven.io → **Create service** → **Apache Kafka** → **Free** plan, region in Europe.
2. When it's running → **Overview**: copy the **Service URI** and download **CA certificate** (`ca.pem`), **Access certificate** (`service.cert`), **Access key** (`service.key`).
3. **Topics** → create, 2 partitions each:
   `restroflow.orders.v1`, `restroflow.catalog.v1`, `restroflow.store.v1`, `restroflow.dlq.v1`

## 2. Render

1. dashboard.render.com → sign up with GitHub → allow access to `restroflow-events`.
2. **New → Blueprint** → choose the repo → Render reads `render.yaml`.
3. Fill in the secret values it asks for:

| Variable | Value |
|---|---|
| `TENANTS` | `{"namaste-india-siegen":"<webhook secret>"}` – make the secret with `openssl rand -hex 32` |
| `KAFKA_BROKERS` | Aiven Service URI (`host:port`) |
| `KAFKA_CA_PEM` | full contents of `ca.pem` |
| `KAFKA_CERT_PEM` | full contents of `service.cert` |
| `KAFKA_KEY_PEM` | full contents of `service.key` |

4. **Apply**. The first build takes a few minutes; then `https://restroflow-events.onrender.com/healthz` answers.

## 3. Own domain

Render → service → **Settings → Custom Domains** shows `events.namasteindia-siegen.com` (from the blueprint). Add the DNS record it shows where the domain is managed:

| Type | Name | Value |
|---|---|---|
| CNAME | `events` | `restroflow-events.onrender.com` (use the exact value Render shows) |

Render issues the HTTPS certificate automatically.

## 4. Connect RestroFlow

WordPress → **RestroFlow → Webhooks → Add webhook**
- URL: `https://events.namasteindia-siegen.com/v1/webhooks/restroflow/namaste-india-siegen`
- Secret: the one from `TENANTS` · Events: all

Open `https://events.namasteindia-siegen.com/` – orders appear on the kitchen pass live.
