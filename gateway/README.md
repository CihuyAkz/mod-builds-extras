# Starling GitHub build gateway (Cloudflare Free)

This gateway implements the endpoints Starling uses for **Use GitHub (slower)**. It stores pending `.hnmod` requests in Cloudflare D1, dispatches this repository's `build.yml`, and serves the compiled library directly from a temporary GitHub Release. It does not use R2, GitHub Actions Artifacts, a VM, or a paid Cloudflare Workers plan.

## What it needs

- A Cloudflare account using the Workers Free plan and one D1 database on the Free allowance.
- A GitHub fine-grained personal access token limited to this repository, with **Actions: Read and write** and **Contents: Read and write**. The gateway uses it to dispatch workflows, read run state, create temporary releases, and remove old release assets/tags. Do not grant unrelated repository permissions.
- The repository must remain public. GitHub documents standard hosted runners as free for public repositories, and GitHub Release assets have no total-size or bandwidth quota (each individual file must be under 2 GiB).

The gateway uses 1.9 MB D1 chunks because D1 limits a single BLOB/row to 2,000,000 bytes. The incoming native-mod request limit remains 32 MiB. Each build gets its own prerelease and tag; the gateway removes them after 24 hours. The compiled library is not stored in D1 or GitHub Actions Artifacts.

## Setup

Run these commands from this `gateway/` directory.

1. Install Node.js LTS and use Wrangler:

   ```sh
   npx wrangler login
   npx wrangler d1 create starling-mod-build-gateway
   ```

2. Copy the `database_id` printed by Wrangler into `wrangler.toml`, replacing `REPLACE_WITH_D1_DATABASE_ID`.

3. The repository is already set to `CihuyAkz/mod-builds-extras` in `wrangler.toml`. Keep `GITHUB_REF` set to the branch containing `.github/workflows/build.yml` (`main` for this repository).

4. Create the D1 tables:

   ```sh
   npx wrangler d1 migrations apply starling-mod-build-gateway --remote
   ```

5. Create a fine-grained GitHub token. Select **Only select repositories**, choose `CihuyAkz/mod-builds-extras`, and grant only:
   - **Actions: Read and write**
   - **Contents: Read and write**

   Save it as a Worker secret:

   ```sh
   npx wrangler secret put GITHUB_TOKEN
   ```

6. Deploy:

   ```sh
   npx wrangler deploy
   ```

   Wrangler prints the public `https://...workers.dev` address. Use that as the Starling build gateway address, then select **Use GitHub (slower)** in Starling.

## Endpoints

- `POST /v1/build?version=VERSION&via=github` — receives the packed native-mod request and returns `{"job":"..."}`.
- `GET /v1/github/ASK` — streams the stored request to the GitHub runner.
- `GET /v1/job/JOB` — returns `queued`, `building`, `failed`, or `done` status.
- `GET /v1/job/JOB/lib` — streams the release asset and supports `Range: bytes=START-` downloads.

A scheduled Worker checks workflow status once a minute and starts up to eight builds at a time. Requests have per-IP and global daily limits. Each upload receives a random job ID rather than hashing the whole body, keeping request processing within the Workers Free CPU budget; an ambiguous retry of the POST may enqueue a second build.

## Storage and visibility

- The runner uploads `status.json` and, on success, `libhorizon_android.so` as assets of a prerelease. This avoids GitHub Actions artifact storage, which has a 500 MB allowance on GitHub Free.
- GitHub Release assets are public because this repository is public. They are removed, along with their temporary tag, after 24 hours. Workflow logs and run metadata are also public.
- Cloudflare Workers Free has a 100,000-request daily limit and a 10 ms CPU limit per invocation. D1 Free includes 5 million row reads and 100,000 row writes per day, a 500 MB maximum database size, a 50-query limit per Worker invocation, and a 2 MB maximum BLOB/row size. Daily D1 limits reset at 00:00 UTC; once a daily read or write allowance is exhausted, new D1 queries fail until it resets. This gateway reserves up to 400 MiB for pending request payloads and stores them in 1.9 MB chunks; payload chunks are deleted after the build finishes.
- The build result must be under GitHub's 2 GiB per-release-asset limit. This service only implements the GitHub-runner route; it does not provide the separate always-on Linux build server route.
