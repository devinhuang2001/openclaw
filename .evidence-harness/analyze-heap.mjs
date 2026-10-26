// Analyze raw synthetic V8 snapshots without displaying captured strings or endpoints.
import fs from "node:fs";
import crypto from "node:crypto";
import assert from "node:assert/strict";

const input = process.argv[2];
const output = process.argv[3];
const raw = fs.readFileSync(input);
const snapshot = JSON.parse(raw.toString("utf8"));
const { nodes, edges, strings } = snapshot;
const meta = snapshot.snapshot.meta;
const nf = meta.node_fields.length;
const ef = meta.edge_fields.length;
const nt = meta.node_types[meta.node_fields.indexOf("type")];
const et = meta.edge_types[meta.edge_fields.indexOf("type")];
const nType = meta.node_fields.indexOf("type");
const nName = meta.node_fields.indexOf("name");
const nId = meta.node_fields.indexOf("id");
const nSize = meta.node_fields.indexOf("self_size");
const nEdges = meta.node_fields.indexOf("edge_count");
const eType = meta.edge_fields.indexOf("type");
const eName = meta.edge_fields.indexOf("name_or_index");
const eTo = meta.edge_fields.indexOf("to_node");
const count = nodes.length / nf;
const starts = new Uint32Array(count + 1);
for (let i = 0; i < count; i++) starts[i + 1] = starts[i] + nodes[i * nf + nEdges] * ef;
assert.equal(starts[count], edges.length);
const name = (i) => strings[nodes[i * nf + nName]];
const type = (i) => nt[nodes[i * nf + nType]];
const edgeLabel = (e) => {
  const kind = et[edges[e + eType]];
  return kind === "element" || kind === "hidden" ? String(edges[e + eName]) : strings[edges[e + eName]];
};
const redact = (s) => String(s).replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[ip-redacted]")
  .replace(/https?:\/\/\S+/g, "[endpoint-redacted]");
const describe = (i) => ({ id: nodes[i * nf + nId], type: type(i), name: redact(name(i)), selfSize: nodes[i * nf + nSize] });
const targets = Object.fromEntries([
  "AbandonedDispatcherTurnFixture", "CompletedDispatcherTurnFixture", "LiveDispatcherTurnFixture",
].map((label) => [label, []]));
for (let i = 0; i < count; i++) {
  if (type(i) === "object" && targets[name(i)]) targets[name(i)].push(i);
}
const registryEdges = [];
for (let i = 0; i < count; i++) {
  for (let e = starts[i]; e < starts[i + 1]; e += ef) {
    if (String(edgeLabel(e)).includes("openclaw.activeReplyDispatchers")) {
      registryEdges.push({ from: i, to: edges[e + eTo] / nf, edge: e });
    }
  }
}

function shortestStrongPaths(root, wanted) {
  const parents = new Int32Array(count).fill(-1);
  const via = new Uint32Array(count);
  const queue = new Uint32Array(count);
  const remaining = new Set(wanted);
  parents[root] = root;
  queue[0] = root;
  let end = 1;
  for (let head = 0; head < end && remaining.size > 0; head++) {
    const i = queue[head];
    remaining.delete(i);
    for (let e = starts[i]; e < starts[i + 1]; e += ef) {
      if (et[edges[e + eType]] === "weak") continue;
      const child = edges[e + eTo] / nf;
      if (parents[child] !== -1) continue;
      parents[child] = i;
      via[child] = e;
      queue[end++] = child;
    }
  }
  return wanted.map((target) => {
    if (parents[target] < 0) return { target: describe(target), reachable: false };
    const path = [];
    for (let i = target; ; i = parents[i]) {
      const e = via[i];
      path.push({ node: describe(i), ...(i === root ? {} : { incoming: {
        type: et[edges[e + eType]], name: redact(edgeLabel(e)),
      } }) });
      if (i === root) break;
    }
    return { target: describe(target), reachable: true, path: path.reverse() };
  });
}

const firstTargets = Object.values(targets).flatMap((list) => list.slice(0, 1));
const registryRoot = registryEdges.find((edge) => type(edge.to) === "object" && name(edge.to) === "Set");
const result = {
  snapshotSha256: crypto.createHash("sha256").update(raw).digest("hex"),
  snapshotBytes: raw.length, nodeCount: count, edgeCount: edges.length / ef,
  constructorObjectCounts: Object.fromEntries(Object.entries(targets).map(([key, value]) => [key, value.length])),
  registrySymbolEdges: registryEdges.map((entry) => ({
    source: describe(entry.from), target: describe(entry.to), name: redact(edgeLabel(entry.edge)),
  })),
  rootStrongPaths: shortestStrongPaths(0, firstTargets),
  registryStrongPaths: registryRoot ? shortestStrongPaths(registryRoot.to, firstTargets) : [],
  method: "Breadth-first paths exclude weak edges. Object counts match exact constructor name and object node type. No retained-size or production-producer attribution is inferred.",
};
fs.writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ input, ...result.constructorObjectCounts, registrySymbolEdges: registryEdges.length }));
