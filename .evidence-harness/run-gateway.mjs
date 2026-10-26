import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL, fileURLToPath } from "node:url";

const sut = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const variant = process.argv[4];
assert.ok(["baseline", "candidate"].includes(variant));
const harness = path.dirname(fileURLToPath(import.meta.url));
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sut, encoding: "utf8" }).trim();
const results = [];
await fs.mkdir(output, { recursive: true });

const sanitize = (value) => value.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[loopback-redacted]")
  .replace(/\b(?:sk-|gh[opsu]_)[A-Za-z0-9_-]{12,}\b/g, "[credential-redacted]");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function start(args, env, cwd) {
  const child = spawn(process.execPath, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (data) => { log = (log + data).slice(-300000); });
  }
  const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, ended, log: () => sanitize(log) };
}

for (let sample = 1; sample <= 5; sample++) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-retention-"));
  const sampleOutput = path.join(output, `sample-${sample}`);
  await fs.mkdir(sampleOutput, { recursive: true });
  const pluginDir = path.join(work, "retention-probe");
  await fs.mkdir(pluginDir);
  await fs.copyFile(path.join(harness, "probe-plugin.mjs"), path.join(pluginDir, "index.mjs"));
  await fs.writeFile(path.join(pluginDir, "package.json"), JSON.stringify({
    name: "retention-probe", version: "1.0.0", type: "module",
    openclaw: { extensions: ["./index.mjs"] },
  }));
  await fs.writeFile(path.join(pluginDir, "openclaw.plugin.json"), JSON.stringify({
    id: "retention-probe", name: "Synthetic dispatcher retention proof",
    activation: { onStartup: true },
    configSchema: { type: "object", additionalProperties: false, properties: {} },
  }));
  const configPath = path.join(work, "openclaw.json");
  await fs.writeFile(configPath, JSON.stringify({
    gateway: { mode: "local", bind: "loopback", auth: { mode: "none" }, controlUi: { enabled: false } },
    agents: { defaults: { workspace: path.join(work, "workspace") } },
    plugins: { enabled: true, allow: ["retention-probe"], slots: { memory: "none" } },
    discovery: { mdns: { mode: "off" } }, cron: { enabled: false },
    logging: { level: "error", file: path.join(work, "gateway.log") },
  }));
  // Do not copy CI credentials, proxy settings, or operator state into the heap.
  const env = {
    PATH: process.env.PATH, HOME: work, TMPDIR: work, CI: "true", TERM: "dumb",
    NODE_DISABLE_COMPILE_CACHE: "1",
    OPENCLAW_STATE_DIR: path.join(work, "state"), OPENCLAW_CONFIG_PATH: configPath,
    RETENTION_SDK_URL: pathToFileURL(path.join(sut, "dist/plugin-sdk/reply-runtime.js")).href,
    RETENTION_OUTPUT_DIR: sampleOutput,
  };
  const install = start(["openclaw.mjs", "plugins", "install", pluginDir, "--link", "--force",
    "--accept-capabilities", "--acknowledge-install-policy-warning"], env, sut);
  const installResult = await Promise.race([install.ended, delay(180000, undefined, { ref: false }).then(() => ({ timeout: true }))]);
  await fs.writeFile(path.join(sampleOutput, "install.log"), install.log());
  if (installResult.code !== 0) {
    install.child.kill("SIGKILL");
    throw new Error(`fixture installation failed: ${JSON.stringify(installResult)}\n${install.log()}`);
  }
  const port = await freePort();
  const gateway = start(["--expose-gc", "openclaw.mjs", "gateway", "run", "--allow-unconfigured",
    "--bind", "loopback", "--auth", "none", "--port", String(port)], env, sut);
  async function request(action) {
    const response = await fetch(`http://127.0.0.1:${port}/__dispatcher_retention?action=${action}`,
      { signal: AbortSignal.timeout(action === "snapshot" ? 180000 : 15000) });
    const body = await response.text();
    assert.equal(response.status, 200, `fixture HTTP ${response.status}: ${sanitize(body)}`);
    return JSON.parse(body);
  }
  try {
    let ready;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline && gateway.child.exitCode === null) {
      try { ready = await request("ready"); break; } catch { await delay(500); }
    }
    assert.ok(ready, `isolated shipped Gateway did not become ready\n${gateway.log()}`);
    assert.equal(ready.registry.pending, 0);
    const created = await request("create");
    assert.equal(created.registry.pending, 18);
    assert.equal(created.registry.registrations, 17);
    const measured = await request("measure");
    assert.equal(measured.completedRetained, 0);
    assert.equal(measured.liveRetained, true);
    assert.equal(measured.registry.pending, 18);
    assert.equal(measured.registry.registrations, 17);
    assert.equal(measured.abandonedRetained, variant === "baseline" ? 16 : 0);
    assert.equal(measured.abandonedDispatchersRetained, variant === "baseline" ? 16 : 0);
    if (sample === 1) await request("snapshot");
    const released = await request("release");
    assert.equal(released.registry.pending, 16);
    assert.equal(released.registry.registrations, 16);
    const afterRelease = await request("measure");
    assert.equal(afterRelease.liveRetained, false);
    const result = {
      sample, sha, node: ready.node, gatewayPid: ready.pid, created, measured, released, afterRelease,
      behaviorAssertion: measured.abandonedRetained === 0 && measured.registry.pending === 18,
      workload: { abandoned: 16, completed: 4, live: 1, livePendingBeforeSettlement: 2 },
    };
    results.push(result);
    await fs.writeFile(path.join(sampleOutput, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ variant, sample, abandonedRetained: measured.abandonedRetained,
      pendingWithLive: measured.registry.pending, pendingAfterLive: released.registry.pending }));
  } finally {
    gateway.child.kill("SIGTERM");
    await Promise.race([gateway.ended, delay(6000, undefined, { ref: false })]);
    if (gateway.child.exitCode === null) gateway.child.kill("SIGKILL");
    await gateway.ended;
    await fs.writeFile(path.join(sampleOutput, "gateway.log"), gateway.log());
  }
}
await fs.writeFile(path.join(output, "results.json"), JSON.stringify({ variant, sha, results }, null, 2));
