# Running 2Options in a TEE on Phala Cloud

One container (`Dockerfile` at the repo root) serves the trade desk, the agent API and the keeper.
On Phala Cloud it runs in an Intel TDX confidential VM managed by dstack, the same stack NEAR AI
Cloud runs on.

## What the TEE gives you, and what it doesn't

- **A quote bound to the signing key.** At startup the agent asks the dstack guest agent for a TDX
  quote whose report data is `sha256("twooptions:agent-key:v1" || agent ed25519 public key)`.
  `GET /attestation` returns it with the public key. Verifying the quote (Intel's signature, the
  VM measurements, and the compose hash in its event log) shows that this key was reported from a
  VM running this compose file, which pins one image by digest, built by CI from one commit.
- **Secrets the host cannot read.** The keys are encrypted secrets in the Phala dashboard,
  decrypted only inside the VM.
- **Not proven: the key's origin.** You generate the key and paste it in, so you know it too.
  The contract also does not verify quotes; the limits on what the agent key can do
  (`contracts/README.md`, "Limits on the agent key") are what protect funds either way.

## Steps

1. **Publish the image.** Push to `main` (or run the `image` workflow by hand). The job summary
   prints `ghcr.io/gks2022004/2options@sha256:…`. In GitHub, Packages → `2options` → settings,
   make the package public so Phala can pull it.
2. **Pin it.** Put that digest in `deploy/phala/docker-compose.yaml` (`image:`) and commit.
3. **Deploy.** Phala Cloud dashboard → Deploy → docker-compose: paste the file, pick `tdx.small`.
   Add the encrypted secrets:
   - `AGENT_PRIVATE_KEY`, `KEEPER_ACCOUNT_ID`, `KEEPER_PRIVATE_KEY`, the same values as `agent/.env`;
   - `TWOOPTIONS_CODE_HASH`, the digest from step 1.
4. **Open it.** Phala gives the app a URL for port 8787. The trade desk is at `/`, and the app
   calls the agent at that same origin. `/health` shows the keeper, and `/attestation` shows the quote.
5. **Stop the local agent.** Only one keeper may run: two would collide on the keeper account's
   nonces.

Contract, token and RPC endpoints default to the testnet deployment (`Dockerfile`, `ENV`).
Override them as environment variables or build arguments for another deployment.

## Run the same image locally

```bash
docker build -t 2options .
docker run --rm --env-file agent/.env -e TWOOPTIONS_CORS_ORIGINS= -p 8787:8787 2options
# open http://localhost:8787
```

Outside a dstack VM there is no socket, so `/attestation` has no `tee` block.
