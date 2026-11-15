const MAX_BODY = 32 * 1024 * 1024;
const CHUNK_SIZE = 1_900_000;
const DAY = 24 * 60 * 60;
const MAX_PER_ADDRESS = 32;
const MAX_PER_DAY = 300;
const MAX_PENDING = 32;
const MAX_PENDING_BYTES = 400 * 1024 * 1024;
const MAX_RUNNING = 8;
const DISPATCH_TIMEOUT = 15 * 60;
const BUILD_TIMEOUT = 75 * 60;
const LIBRARY_NAME = "libhorizon_android.so";
const API_VERSION = "2022-11-28";
const encoder = new TextEncoder();

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function error(status, message) {
  return json({ error: message }, status);
}

function repoName(env) {
  const value = String(env.GITHUB_REPO || "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("Set GITHUB_REPO to owner/repository in wrangler.toml.");
  }
  return value;
}

function apiUrl(env, path) {
  return `https://api.github.com/repos/${repoName(env)}${path}`;
}

function githubHeaders(env, extra = {}) {
  if (!env.GITHUB_TOKEN) {
    throw new Error("The GITHUB_TOKEN Worker secret is not configured.");
  }
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "starling-mod-build-gateway",
    ...extra,
  };
}

async function githubJson(env, path, options = {}) {
  const headers = githubHeaders(env, {
    ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(options.headers || {}),
  });
  const response = await fetch(apiUrl(env, path), {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  if (response.status === 404 && options.allow404) return null;
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function sha256Hex(data) {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function releaseTag(job) {
  return job.release_tag || `starling-mod-build-${job.ask}`;
}

function assetUrl(env, asset) {
  const expected = `https://github.com/${repoName(env)}/releases/download/`;
  const url = String(asset?.browser_download_url || "");
  if (!url.startsWith(expected)) {
    throw new Error("GitHub returned an unexpected release asset URL.");
  }
  return url;
}

async function retryReleaseCollection(env, job, releaseId = null) {
  const attempts = Number(job.collect_attempts || 0) + 1;
  if (attempts >= 10) {
    await failJob(env, job.job, "The build result did not arrive from GitHub. Try again.", false);
    return;
  }
  await env.DB.prepare(`
    UPDATE jobs SET state = 'collecting', collect_attempts = ?,
      release_id = COALESCE(?, release_id), run_id = ?, updated_at = ?
    WHERE job = ?
  `).bind(
    attempts,
    releaseId,
    job.run_id || null,
    Math.floor(Date.now() / 1000),
    job.job,
  ).run();
}

async function collectRelease(env, job, run) {
  const tag = releaseTag(job);
  const release = await githubJson(
    env,
    `/releases/tags/${encodeURIComponent(tag)}`,
    { allow404: true },
  );
  if (!release) {
    await retryReleaseCollection(env, job);
    return;
  }

  const statusAsset = (release.assets || []).find((asset) => asset.name === "status.json");
  const libraryAsset = (release.assets || []).find((asset) => asset.name === LIBRARY_NAME);
  if (!statusAsset) {
    await retryReleaseCollection(env, job, release.id);
    return;
  }

  const statusResponse = await fetch(assetUrl(env, statusAsset));
  if (!statusResponse.ok) {
    throw new Error(`Could not read the build status asset (${statusResponse.status}).`);
  }
  const statusText = await statusResponse.text();
  if (statusText.length > 1_000_000) throw new Error("The build status asset is too large.");
  const status = JSON.parse(statusText);

  if (status.state === "failed") {
    await env.DB.prepare(
      "UPDATE jobs SET release_id = ?, updated_at = ? WHERE job = ?",
    ).bind(release.id, Math.floor(Date.now() / 1000), job.job).run();
    await failJob(
      env,
      job.job,
      String(status.error || "The build failed.").slice(0, 600),
      Boolean(status.settled),
    );
    return;
  }

  if (
    status.state !== "done" ||
    !libraryAsset ||
    !/^[0-9a-f]{64}$/.test(String(status.sha256 || "")) ||
    !Number.isSafeInteger(Number(status.size)) ||
    Number(status.size) <= 0 ||
    Number(status.size) !== Number(libraryAsset.size)
  ) {
    throw new Error("The build release's status or library asset is invalid.");
  }

  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE jobs
      SET state = 'done', sha256 = ?, result_size = ?, build_json = ?,
          release_id = ?, library_asset_id = ?, library_url = ?,
          library_asset_size = ?, finished_at = ?, updated_at = ?,
          error = NULL, settled = 0
      WHERE job = ?
    `).bind(
      status.sha256,
      Number(status.size),
      JSON.stringify(status.build || {}),
      Number(release.id),
      Number(libraryAsset.id),
      assetUrl(env, libraryAsset),
      Number(libraryAsset.size),
      now,
      now,
      job.job,
    ),
    env.DB.prepare("DELETE FROM payload_chunks WHERE job = ?").bind(job.job),
  ]);
}

async function failJob(env, job, message, settled) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE jobs SET state = 'failed', error = ?, settled = ?,
        finished_at = ?, updated_at = ? WHERE job = ?
    `).bind(String(message).slice(0, 600), settled ? 1 : 0, now, now, job),
    env.DB.prepare("DELETE FROM payload_chunks WHERE job = ?").bind(job),
  ]);
}

async function dispatchJob(env, job) {
  const now = Math.floor(Date.now() / 1000);
  const claim = await env.DB.prepare(`
    UPDATE jobs SET state = 'dispatching', dispatched_at = ?, updated_at = ?
    WHERE job = ? AND state = 'waiting'
  `).bind(now, now, job.job).run();
  if (!claim.meta?.changes) return false;

  try {
    const release = await githubJson(env, "/releases", {
      method: "POST",
      body: {
        tag_name: releaseTag(job),
        target_commitish: env.GITHUB_REF || "main",
        name: `Temporary Starling mod build ${job.ask}`,
        body: "Temporary gateway output. This release and its tag are removed after 24 hours.",
        draft: false,
        prerelease: true,
      },
    });
    if (!release?.id) throw new Error("GitHub did not create the temporary build release.");
    await env.DB.prepare(
      "UPDATE jobs SET release_id = ?, updated_at = ? WHERE job = ?",
    ).bind(Number(release.id), Math.floor(Date.now() / 1000), job.job).run();

    const workflow = encodeURIComponent(env.GITHUB_WORKFLOW || "build.yml");
    await githubJson(env, `/actions/workflows/${workflow}/dispatches`, {
      method: "POST",
      body: {
        ref: env.GITHUB_REF || "main",
        inputs: {
          ask: job.ask,
          version: job.version,
          gateway: job.gateway_url,
          release_tag: releaseTag(job),
        },
      },
    });
    await env.DB.prepare(
      "UPDATE jobs SET state = 'asked', updated_at = ? WHERE job = ? AND state = 'dispatching'",
    ).bind(Math.floor(Date.now() / 1000), job.job).run();
    return true;
  } catch (cause) {
    await failJob(env, job.job, `GitHub refused the build: ${String(cause.message || cause).slice(0, 450)}`, false);
    return false;
  }
}

async function cleanupExpiredJobs(env, cutoff) {
  const expired = await env.DB.prepare(`
    SELECT job, ask, release_tag, release_id FROM jobs
    WHERE created_at < ? ORDER BY created_at ASC LIMIT 3
  `).bind(cutoff).all();

  for (const job of expired.results || []) {
    const tag = job.release_tag || `starling-mod-build-${job.ask}`;
    try {
      let releaseId = Number(job.release_id || 0);
      if (!releaseId) {
        const release = await githubJson(
          env,
          `/releases/tags/${encodeURIComponent(tag)}`,
          { allow404: true },
        );
        releaseId = Number(release?.id || 0);
      }
      if (releaseId) {
        await githubJson(env, `/releases/${releaseId}`, { method: "DELETE", allow404: true });
      }
      await githubJson(
        env,
        `/git/refs/tags/${encodeURIComponent(tag)}`,
        { method: "DELETE", allow404: true },
      );
    } catch (cause) {
      console.error(`Could not remove expired release for ${job.job}:`, cause);
      continue;
    }

    await env.DB.batch([
      env.DB.prepare("DELETE FROM payload_chunks WHERE job = ?").bind(job.job),
      env.DB.prepare("DELETE FROM jobs WHERE job = ?").bind(job.job),
    ]);
  }
}

async function processSchedule(env) {
  if (!env.DB || !env.GITHUB_TOKEN) throw new Error("D1 or GITHUB_TOKEN is not configured.");
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - DAY;

  await cleanupExpiredJobs(env, cutoff);

  const activeResult = await env.DB.prepare(`
    SELECT * FROM jobs
    WHERE state IN ('dispatching', 'asked', 'queued', 'building', 'collecting')
    ORDER BY created_at ASC LIMIT 6
  `).all();
  const active = activeResult.results || [];
  let runs = [];
  if (active.some((job) => ["asked", "queued", "building", "collecting"].includes(job.state))) {
    const workflow = encodeURIComponent(env.GITHUB_WORKFLOW || "build.yml");
    const runList = await githubJson(
      env,
      `/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=100`,
    );
    runs = runList?.workflow_runs || [];
  }
  const runsByTitle = new Map(
    runs.map((run) => [run.display_title || run.name, run]),
  );

  let collectedOne = false;
  for (const job of active) {
    if (job.state === "dispatching") {
      if (now - Number(job.dispatched_at || job.created_at) > DISPATCH_TIMEOUT) {
        await failJob(env, job.job, "GitHub did not accept the build request. Try again later.", false);
      }
      continue;
    }
    const run = runsByTitle.get(`build ${job.ask}`);
    if (!run) {
      if (now - Number(job.dispatched_at || job.created_at) > DISPATCH_TIMEOUT) {
        await failJob(env, job.job, "GitHub did not start the build. Try again later.", false);
      }
      continue;
    }

    if (
      run.status !== "completed" &&
      now - Number(job.dispatched_at || job.created_at) > BUILD_TIMEOUT
    ) {
      await failJob(env, job.job, "The build took too long. Try again later.", false);
      continue;
    }
    if (run.status === "queued" || run.status === "requested" || run.status === "waiting") {
      await env.DB.prepare(
        "UPDATE jobs SET state = 'queued', run_id = ?, updated_at = ? WHERE job = ?",
      ).bind(run.id, now, job.job).run();
      continue;
    }
    if (run.status === "in_progress") {
      const startedAt = run.run_started_at ? Math.floor(Date.parse(run.run_started_at) / 1000) : now;
      await env.DB.prepare(
        "UPDATE jobs SET state = 'building', run_id = ?, run_started_at = ?, updated_at = ? WHERE job = ?",
      ).bind(run.id, startedAt, now, job.job).run();
      continue;
    }
    if (run.status === "completed") {
      if (run.conclusion !== "success") {
        await failJob(env, job.job, "The build on GitHub did not finish. Try again.", false);
      } else if (!collectedOne) {
        collectedOne = true;
        try {
          await collectRelease(env, job, run);
        } catch (cause) {
          console.error(`Could not collect release assets for ${job.job}:`, cause);
          await failJob(env, job.job, "The build result could not be read. Try again.", false);
        }
      } else {
        await env.DB.prepare(
          "UPDATE jobs SET state = 'collecting', run_id = ?, updated_at = ? WHERE job = ?",
        ).bind(run.id, now, job.job).run();
      }
    }
  }

  const countRow = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM jobs
    WHERE state IN ('dispatching', 'asked', 'queued', 'building')
  `).first();
  let running = Number(countRow?.count || 0);
  const waiting = await env.DB.prepare(
    "SELECT * FROM jobs WHERE state = 'waiting' ORDER BY created_at ASC LIMIT 32",
  ).all();
  for (const job of waiting.results || []) {
    if (running >= MAX_RUNNING) break;
    if (await dispatchJob(env, job)) running++;
  }
}

async function acceptBuild(request, env) {
  if (!env.GITHUB_TOKEN) return error(503, "The gateway has not been configured with its GitHub token.");
  try {
    repoName(env);
  } catch {
    return error(503, "The gateway has not been configured with its GitHub repository.");
  }
  const url = new URL(request.url);
  const version = url.searchParams.get("version") || "";
  const via = url.searchParams.get("via") || "";
  if (via !== "github") {
    return error(400, "This gateway only supports the Use GitHub (slower) build option.");
  }
  if (!/^\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(version)) {
    return error(400, "That is not a version of the game.");
  }
  const contentLength = request.headers.get("Content-Length");
  const declaredSize = Number(contentLength || 0);
  if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0) {
    return error(411, "The build request must include its Content-Length.");
  }
  if (declaredSize > MAX_BODY) return error(413, "That is too big to compile.");

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength !== declaredSize || body.byteLength > MAX_BODY) {
    return error(400, "The build request length did not match its Content-Length.");
  }

  // Use opaque random IDs rather than hashing a potentially 32 MiB body. Workers Free
  // allows only 10 ms of CPU per request, so a full-payload digest can exceed its budget.
  const requestKeyBytes = new Uint8Array(16);
  const askBytes = new Uint8Array(16);
  crypto.getRandomValues(requestKeyBytes);
  crypto.getRandomValues(askBytes);
  const requestKey = hex(requestKeyBytes);
  const job = requestKey.slice(0, 24);
  const ask = hex(askBytes);
  const now = Math.floor(Date.now() / 1000);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const addressHash = await sha256Hex(encoder.encode(ip));
  const limits = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM jobs WHERE address_hash = ? AND created_at >= ?) AS address_count,
      (SELECT COUNT(*) FROM jobs WHERE created_at >= ?) AS daily_count,
      (SELECT COUNT(*) FROM jobs WHERE state IN ('waiting', 'dispatching', 'asked', 'queued', 'building', 'collecting')) AS pending_count,
      (SELECT COALESCE(SUM(payload_size), 0) FROM jobs WHERE state IN ('waiting', 'dispatching', 'asked', 'queued', 'building', 'collecting')) AS pending_bytes
  `).bind(addressHash, now - DAY, now - DAY).first();
  if (Number(limits?.address_count || 0) >= MAX_PER_ADDRESS) {
    return error(429, "You have reached today's build limit. Try again tomorrow.");
  }
  if (Number(limits?.daily_count || 0) >= MAX_PER_DAY) {
    return error(429, "The build gateway has reached today's limit for all players. Try again tomorrow.");
  }
  if (Number(limits?.pending_count || 0) >= MAX_PENDING) {
    return error(429, "The line for GitHub is full. Try again in a few minutes.");
  }
  if (Number(limits?.pending_bytes || 0) + body.byteLength > MAX_PENDING_BYTES) {
    return error(429, "The gateway's temporary storage is full. Try again later.");
  }

  const chunkCount = Math.ceil(body.byteLength / CHUNK_SIZE);
  const statements = [
    env.DB.prepare(`
      INSERT INTO jobs (
        job, request_key, ask, version, address_hash, payload_size,
        chunk_count, gateway_url, release_tag, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)
    `).bind(
      job,
      requestKey,
      ask,
      version,
      addressHash,
      body.byteLength,
      chunkCount,
      new URL(request.url).origin,
      `starling-mod-build-${ask}`,
      now,
      now,
    ),
  ];
  for (let index = 0; index < chunkCount; index++) {
    const start = index * CHUNK_SIZE;
    const chunk = body.subarray(start, Math.min(start + CHUNK_SIZE, body.byteLength));
    statements.push(
      env.DB.prepare("INSERT INTO payload_chunks (job, chunk_index, data) VALUES (?, ?, ?)")
        .bind(job, index, chunk),
    );
  }

  try {
    await env.DB.batch(statements);
  } catch (cause) {
    console.error("Could not store the build request:", cause);
    return error(503, "The build gateway could not store this request. Try again later.");
  }
  return json({ job });
}

async function serveMods(ask, env) {
  if (!/^[0-9a-f]{32}$/.test(ask)) return error(404, "No such thing here.");
  const job = await env.DB.prepare(
    "SELECT job, payload_size, chunk_count FROM jobs WHERE ask = ?",
  ).bind(ask).first();
  if (!job) return error(404, "No such thing here.");

  let index = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      if (index >= Number(job.chunk_count)) {
        controller.close();
        return;
      }
      try {
        const row = await env.DB.prepare(
          "SELECT data FROM payload_chunks WHERE job = ? AND chunk_index = ?",
        ).bind(job.job, index).first();
        if (!row?.data) throw new Error("A request payload chunk is missing.");
        controller.enqueue(new Uint8Array(row.data));
        index++;
        if (index >= Number(job.chunk_count)) controller.close();
      } catch (cause) {
        controller.error(cause);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(job.payload_size),
      "Cache-Control": "no-store",
    },
  });
}

async function serveJobStatus(jobId, env) {
  if (!/^[0-9a-f]{24}$/.test(jobId)) return error(404, "No such job.");
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE job = ?").bind(jobId).first();
  if (!job) return error(404, "No such job.");

  if (job.state === "failed") {
    return json({ state: "failed", error: job.error || "The build failed.", settled: Boolean(job.settled) });
  }
  if (job.state === "done") {
    return json({
      state: "done",
      sha256: job.sha256,
      size: Number(job.result_size),
      build: JSON.parse(job.build_json || "{}"),
    });
  }
  if (["waiting", "dispatching", "asked", "queued"].includes(job.state)) {
    const ahead = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM jobs
      WHERE created_at < ? AND state IN ('waiting', 'dispatching', 'asked', 'queued')
    `).bind(job.created_at).first();
    return json({ state: "queued", ahead: Number(ahead?.count || 0) });
  }
  const began = Number(job.run_started_at || job.dispatched_at || job.created_at);
  return json({ state: "building", seconds: Math.max(0, Math.floor(Date.now() / 1000) - began) });
}

async function serveLibrary(request, jobId, env) {
  if (!/^[0-9a-f]{24}$/.test(jobId)) return error(404, "No such thing here.");
  const job = await env.DB.prepare(`
    SELECT state, library_url, result_size
    FROM jobs WHERE job = ?
  `).bind(jobId).first();
  if (!job || job.state !== "done" || !job.library_url) return error(404, "No such thing here.");

  const size = Number(job.result_size);
  const rangeHeader = request.headers.get("Range");
  let start = 0;
  let end = size - 1;
  let partial = false;
  if (rangeHeader) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
    if (!match) return error(416, "That byte range is not supported.");
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    partial = true;
    if (!Number.isSafeInteger(start) || start < 0 || start >= size || end < start) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}`, "Cache-Control": "no-store" },
      });
    }
  }

  try {
    const headers = rangeHeader ? { Range: `bytes=${start}-${end}` } : {};
    const download = await fetch(job.library_url, { headers });
    if (partial && download.status !== 206) {
      return error(502, "GitHub Release did not honor the requested byte range.");
    }
    if (!partial && !download.ok) {
      return error(502, "The build result could not be downloaded from GitHub.");
    }
    const responseHeaders = new Headers({
      "Content-Type": "application/octet-stream",
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    });
    if (partial) responseHeaders.set("Content-Range", `bytes ${start}-${end}/${size}`);
    return new Response(download.body, { status: partial ? 206 : 200, headers: responseHeaders });
  } catch (cause) {
    console.error(`Could not serve library for ${jobId}:`, cause);
    return error(502, "The build result could not be downloaded from GitHub. Try again.");
  }
}

async function handleRequest(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Range",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (request.method === "POST" && url.pathname === "/v1/build") {
    return acceptBuild(request, env);
  }
  if (request.method === "GET" && parts.length === 3 && parts[0] === "v1" && parts[1] === "github") {
    return serveMods(parts[2], env);
  }
  if (request.method === "GET" && parts.length === 3 && parts[0] === "v1" && parts[1] === "job") {
    return serveJobStatus(parts[2], env);
  }
  if (request.method === "GET" && parts.length === 4 && parts[0] === "v1" && parts[1] === "job" && parts[3] === "lib") {
    return serveLibrary(request, parts[2], env);
  }
  return error(404, "No such thing here.");
}

export default {
  async fetch(request, env) {
    try {
      if (!env.DB) return error(500, "The D1 database binding is missing.");
      return await handleRequest(request, env);
    } catch (cause) {
      console.error("Gateway request failed:", cause);
      return error(500, "The build gateway encountered an error.");
    }
  },

  async scheduled(_event, env, _ctx) {
    try {
      await processSchedule(env);
    } catch (cause) {
      console.error("Gateway scheduler failed:", cause);
    }
  },
};
