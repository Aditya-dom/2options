# Agent on an Oracle Cloud Always Free VM

The shared testnet deployment runs this way: the app on Vercel (`app/vercel.json`), the agent
(quotes, keeper, hedger) on one Oracle **Always Free** VM, with Caddy in front for HTTPS.
Nothing here is billed when it stays inside the Always Free limits.

| Piece | Where |
|---|---|
| App | https://2options.vercel.app (Vercel Hobby) |
| Agent API | https://130-210-102-123.sslip.io (`sslip.io` maps the name to the VM's IP, so Caddy gets a free certificate without a domain) |
| VM | `VM.Standard.E2.1.Micro`, Ubuntu 24.04, home region `ap-mumbai-1`, 47 GB boot volume, ephemeral public IP |

## Staying free

Always Free compute only applies in the tenancy's **home region**. Use `VM.Standard.E2.1.Micro`
(up to two per tenancy), keep block storage under 200 GB in total, and do not add load
balancers, reserved IPs or extra volumes. The agent's traffic is a few MB a day against 10 TB of
free egress a month.

## Setting it up again

1. Network: a VCN with an internet gateway, a default route to it, and a public subnet whose
   security list allows TCP 22, 80 and 443 in.
2. VM: the shape above with an SSH key and a public IP. On the VM: 2 GB of swap (it has 1 GB of
   RAM), `docker.io`, `docker-compose-v2`, and `iptables` rules accepting 80 and 443 (Oracle's
   Ubuntu images reject them by default) saved with `netfilter-persistent`.
3. In `/opt/2options` on the VM: this `docker-compose.yml` and `Caddyfile` (change the host name
   to the new IP), `agent.env` with mode 600, and `.env` with `CORS_ORIGINS=<app origin>`.

   `agent.env` holds only what the agent needs: `NEAR_NETWORK`, `NEAR_RPC_URL`,
   `TWOOPTIONS_CONTRACT_ID`, `TWOOPTIONS_USDC_ID`, `AGENT_PRIVATE_KEY`, `KEEPER_ACCOUNT_ID`,
   `KEEPER_PRIVATE_KEY`, the `HYPERLIQUID_*` settings, `TWOOPTIONS_MAX_*` and `HEDGE_MAX_*`.
   Never the contract owner's key.
4. `sudo docker compose up -d`. Check `https://<host>/health`.
5. Run only one agent per contract and per Hyperliquid account: stop any other.

To update, pin the new image digest (the `image` workflow prints it) in `docker-compose.yml` and
run `sudo docker compose up -d` again.
