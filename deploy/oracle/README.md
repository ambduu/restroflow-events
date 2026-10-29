# Production on Oracle Cloud (Always Free) + Aiven Kafka (free)

```
RestroFlow ──HTTPS──▶ Caddy ──▶ ingest ──TLS──▶ Aiven Kafka ──TLS──▶ analytics ──▶ dashboard
                    (Oracle VM, Docker Compose, Let's Encrypt)
```

Deployments are automatic: every push to `main` that passes CI is deployed by `.github/workflows/deploy.yml` over SSH. All configuration comes from GitHub secrets.

## 1. Aiven Kafka (free plan)

1. console.aiven.io → **Create service** → **Apache Kafka** → **Free** plan, region in Europe.
2. When it's running, open the service → **Overview**:
   - **Service URI** (`kafka-xxxx.aivencloud.com:12345`) → secret `KAFKA_BROKERS`
   - Download **CA certificate** (`ca.pem`), **Access certificate** (`service.cert`) and **Access key** (`service.key`).
3. **Topics** → create these four, 2 partitions each (the free plan allows 5 topics):
   `restroflow.orders.v1`, `restroflow.catalog.v1`, `restroflow.store.v1`, `restroflow.dlq.v1`

## 2. Oracle Cloud VM

1. Create an SSH key on your Mac (only for deployments):
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/restroflow_deploy -N "" -C "restroflow-deploy"
   cat ~/.ssh/restroflow_deploy.pub   # paste into Oracle in step 2
   ```
2. Oracle console → **Compute → Instances → Create instance**
   - Image: **Canonical Ubuntu 24.04** · Shape: **Ampere → VM.Standard.A1.Flex**, 2 OCPU, 12 GB (within Always Free)
   - Networking: create a new VCN with a **public subnet**, **assign a public IPv4 address**
   - SSH keys: **Paste public key** from step 1
   - If it says *Out of capacity*, try another availability domain or retry later.
3. Open ports 80 and 443: instance → **Subnet → Default security list → Add ingress rules**
   source `0.0.0.0/0`, TCP, destination ports `80,443` (the host firewall is opened by `bootstrap.sh`).
4. Note the **public IP**.

## 3. A host name for HTTPS

Point a DNS **A record** at the VM's public IP, e.g. `events.<your-domain>` → `<public IP>`. Caddy then gets a Let's Encrypt certificate automatically.

## 4. GitHub secrets

Repo → **Settings → Environments → New environment `production`** → add environment secrets:

| Secret | Value |
|---|---|
| `ORACLE_HOST` | public IP of the VM |
| `ORACLE_USER` | `ubuntu` |
| `ORACLE_SSH_KEY` | contents of `~/.ssh/restroflow_deploy` (the private key) |
| `SITE_ADDRESS` | e.g. `events.example.com` |
| `ACME_EMAIL` | your e-mail (Let's Encrypt expiry notices) |
| `TENANTS` | `{"namaste-india-siegen":"<long random secret>"}` – the same secret goes into RestroFlow |
| `KAFKA_BROKERS` | Aiven Service URI |
| `KAFKA_CA_PEM` | contents of `ca.pem` |
| `KAFKA_CERT_PEM` | contents of `service.cert` |
| `KAFKA_KEY_PEM` | contents of `service.key` |

Generate the webhook secret: `openssl rand -hex 32`.

## 5. Deploy

**Actions → Deploy → Oracle Cloud → Run workflow**. The first run installs Docker, opens the firewall, builds the images on the VM (a few minutes on ARM) and checks `https://<SITE_ADDRESS>/healthz`.

## 6. Connect RestroFlow

WordPress → **RestroFlow → Webhooks → Add webhook**
- URL: `https://<SITE_ADDRESS>/v1/webhooks/restroflow/namaste-india-siegen`
- Format: RestroFlow · Secret: the one from `TENANTS` · Events: all

Then open `https://<SITE_ADDRESS>/` – new orders appear on the pass live.

## Operations

```bash
ssh -i ~/.ssh/restroflow_deploy ubuntu@<IP>
cd /opt/restroflow/repo
docker compose -f deploy/oracle/compose.prod.yml ps
docker compose -f deploy/oracle/compose.prod.yml logs -f analytics
```

Rebuild statistics from Kafka (replay): change `ANALYTICS_GROUP_ID` in the deploy workflow, delete the `restroflow_analytics-data` volume and redeploy. History goes back as far as the topic retention allows.
