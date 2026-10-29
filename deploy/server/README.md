# Production: Hetzner Cloud VPS + Aiven Kafka (free)

```
RestroFlow ──HTTPS──▶ Caddy ──▶ ingest ──TLS──▶ Aiven Kafka ──TLS──▶ analytics ──▶ dashboard
                   (Hetzner CX23, Docker Compose, Let's Encrypt)
```

Deployments are automatic: every push to `main` that passes CI is deployed by `.github/workflows/deploy.yml` over SSH. All configuration comes from GitHub secrets. The same setup works on any Ubuntu VPS (including Oracle Cloud – `bootstrap.sh` opens Oracle's host firewall when needed).

## 1. Aiven Kafka (free plan)

1. console.aiven.io → **Create service** → **Apache Kafka** → **Free** plan, region in Europe.
2. When it's running, open the service → **Overview**:
   - **Service URI** (`kafka-xxxx.aivencloud.com:12345`) → secret `KAFKA_BROKERS`
   - Download **CA certificate** (`ca.pem`), **Access certificate** (`service.cert`) and **Access key** (`service.key`).
3. **Topics** → create these four, 2 partitions each (the free plan allows 5 topics):
   `restroflow.orders.v1`, `restroflow.catalog.v1`, `restroflow.store.v1`, `restroflow.dlq.v1`

## 2. Hetzner server

1. Create a deploy key on your Mac:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/restroflow_deploy -N "" -C "restroflow-deploy"
   cat ~/.ssh/restroflow_deploy.pub
   ```
2. console.hetzner.com → new project `restroflow` → **Security → SSH keys → Add** (paste the `.pub` line).
3. **Firewalls → Create firewall** `web`: inbound TCP **22**, **80**, **443** and UDP **443** from any IPv4/IPv6.
4. **Servers → Add server**
   - Location: **Nuremberg** or **Falkenstein** (Germany) – close to Siegen and to Aiven's EU regions
   - Image: **Ubuntu 24.04** · Type: **Shared vCPU → x86 → CX23** (2 vCPU, 4 GB)
   - Networking: **Public IPv4** + IPv6 · SSH key: the one from step 2 · Firewall: `web`
   - Name: `restroflow-1`
5. Note the **public IPv4**.

## 3. Host name for HTTPS

DNS **A record** for your host name (e.g. `events.example.com`) → the server's IPv4. Caddy then gets a Let's Encrypt certificate automatically.

## 4. GitHub secrets

Repo → **Settings → Environments → `production`** → **Add environment secret**:

| Secret | Value |
|---|---|
| `SERVER_HOST` | server IPv4 |
| `SERVER_USER` | `root` |
| `SERVER_SSH_KEY` | contents of `~/.ssh/restroflow_deploy` (the **private** key) |
| `SITE_ADDRESS` | e.g. `events.example.com` |
| `ACME_EMAIL` | your e-mail (Let's Encrypt notices) |
| `TENANTS` | `{"namaste-india-siegen":"<webhook secret>"}` – the same secret goes into RestroFlow |
| `KAFKA_BROKERS` | Aiven Service URI |
| `KAFKA_CA_PEM` | contents of `ca.pem` |
| `KAFKA_CERT_PEM` | contents of `service.cert` |
| `KAFKA_KEY_PEM` | contents of `service.key` |

Webhook secret: `openssl rand -hex 32`.

## 5. Deploy

**Actions → Deploy → production server → Run workflow**. The first run installs Docker, adds swap and automatic security updates, builds the images on the server and checks `https://<SITE_ADDRESS>/healthz`.

## 6. Connect RestroFlow

WordPress → **RestroFlow → Webhooks → Add webhook**
- URL: `https://<SITE_ADDRESS>/v1/webhooks/restroflow/namaste-india-siegen`
- Format: RestroFlow · Secret: the one from `TENANTS` · Events: all

Then open `https://<SITE_ADDRESS>/` – new orders appear on the pass live.

## Operations

```bash
ssh -i ~/.ssh/restroflow_deploy root@<IP>
cd /opt/restroflow/repo
docker compose -f deploy/server/compose.prod.yml ps
docker compose -f deploy/server/compose.prod.yml logs -f analytics
```

Rebuild statistics from Kafka (replay): delete the `restroflow_analytics-data` volume, change `ANALYTICS_GROUP_ID` in the deploy workflow and redeploy. History goes back as far as the topic retention allows.
