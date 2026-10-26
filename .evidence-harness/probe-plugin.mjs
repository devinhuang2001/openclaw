// Fault-injection fixture only. All dispatcher code comes from the shipped SDK.
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { writeHeapSnapshot } from "node:v8";
import path from "node:path";

let createReplyDispatcher;
const abandoned = [];
const completed = [];
const dispatcherRefs = [];
let live;
let releaseLive;
let liveRef;
let created = false;

class AbandonedDispatcherTurnFixture {
  constructor(id) {
    this.id = id;
    this.skillsSnapshot = Array.from({ length: 4000 }, (_, n) => `synthetic-skill-${id}-${n}`);
  }
}

class CompletedDispatcherTurnFixture {
  constructor(id) {
    this.id = id;
    this.skillsSnapshot = Array.from({ length: 4000 }, (_, n) => `completed-skill-${id}-${n}`);
  }
}

class LiveDispatcherTurnFixture {
  constructor() {
    this.id = "live-delivery-control";
    this.skillsSnapshot = Array.from({ length: 4000 }, (_, n) => `live-skill-${n}`);
  }
}

function createAbandoned(id) {
  const turn = new AbandonedDispatcherTurnFixture(id);
  const dispatcher = createReplyDispatcher({
    deliver: async () => ({ visibleReplySent: turn.id.length > 0 }),
  });
  abandoned.push(new WeakRef(turn));
  dispatcherRefs.push(new WeakRef(dispatcher));
  // Intentionally omit markComplete, matching the incident's unresolved producer fault.
}

async function createCompleted(id) {
  const turn = new CompletedDispatcherTurnFixture(id);
  const dispatcher = createReplyDispatcher({
    deliver: async () => ({ visibleReplySent: turn.id.length > 0 }),
  });
  completed.push(new WeakRef(turn));
  dispatcher.sendFinalReply({ text: "Synthetic completed delivery" });
  dispatcher.markComplete();
  await dispatcher.waitForIdle();
}

async function createLive() {
  const turn = new LiveDispatcherTurnFixture();
  const deliveryGate = new Promise((resolve) => { releaseLive = resolve; });
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  live = createReplyDispatcher({
    deliver: async () => {
      notifyStarted();
      await deliveryGate;
      return { visibleReplySent: turn.id.length > 0 };
    },
  });
  liveRef = new WeakRef(turn);
  live.sendFinalReply({ text: "Synthetic held delivery" });
  live.markComplete();
  await started;
}

function registry() {
  const entries = globalThis[Symbol.for("openclaw.activeReplyDispatchers")];
  assert.ok(entries instanceof Set, "real process-wide Gateway registry must exist");
  return {
    registrations: entries.size,
    pending: [...entries].reduce((sum, entry) => sum +
      (typeof entry.pending === "function" ? entry.pending() : entry.pending), 0),
    callbackEntries: [...entries].filter((entry) => typeof entry.pending === "function").length,
  };
}

export default {
  id: "retention-probe",
  name: "Synthetic dispatcher retention proof",
  register(api) {
    api.registerHttpRoute({
      path: "/__dispatcher_retention",
      match: "exact",
      auth: "gateway",
      gatewayRuntimeScopeSurface: "trusted-operator",
      async handler(req, res) {
        try {
          // Plugin entry loading is synchronous; native SDK import belongs to the async request.
          createReplyDispatcher ??= (await import(process.env.RETENTION_SDK_URL)).createReplyDispatcher;
          const action = new URL(req.url, "http://localhost").searchParams.get("action");
          let result;
          if (action === "ready") {
            result = { pid: process.pid, node: process.version, registry: registry() };
          } else if (action === "create") {
            assert.equal(created, false);
            created = true;
            for (let i = 0; i < 16; i++) createAbandoned(i);
            for (let i = 0; i < 4; i++) await createCompleted(i);
            await createLive();
            result = { registry: registry() };
          } else if (action === "measure") {
            assert.equal(typeof globalThis.gc, "function");
            for (let i = 0; i < 8; i++) {
              globalThis.gc();
              await nextTurn();
            }
            result = {
              abandonedRetained: abandoned.filter((ref) => ref.deref() !== undefined).length,
              abandonedDispatchersRetained: dispatcherRefs.filter((ref) => ref.deref() !== undefined).length,
              completedRetained: completed.filter((ref) => ref.deref() !== undefined).length,
              liveRetained: liveRef.deref() !== undefined,
              registry: registry(),
              heapUsed: process.memoryUsage().heapUsed,
            };
          } else if (action === "snapshot") {
            const file = path.join(process.env.RETENTION_OUTPUT_DIR, "gateway.heapsnapshot");
            writeHeapSnapshot(file);
            result = { file: path.basename(file), registry: registry() };
          } else if (action === "release") {
            releaseLive();
            await live.waitForIdle();
            live = undefined;
            releaseLive = undefined;
            result = { registry: registry() };
          } else {
            throw new Error("unknown fixture action");
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(result));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: error.stack }));
        }
        return true;
      },
    });
  },
};
