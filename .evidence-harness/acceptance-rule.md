# Dispatcher registry retention acceptance rule

Written before the first experiment run. This is a controlled fault-injection workload, not a reproduction of the unidentified incident producer.

Pinned baseline: `db92acff277255f64e14866d29ebcb00592822b1` (the introduced commit's direct parent).
The PR API's current base `a53b4975e99d13a4725c64f2254ab857fb574343` includes unrelated changes. The parent comparison isolates the four-file introduced patch; dispatcher owner sources and dependency/build configuration were also checked against the API base.
Pinned initial candidate: `d03f658ff64b41859d8cbc4309800cc2cf494f00`.
Runtime: Linux, exact Node `24.22.1`, pinned pnpm `12.15.0`.

The unmodified canonical runtime build is launched with the shipped `openclaw.mjs gateway run` CLI. An explicitly installed synthetic plugin exposes a loopback-only Gateway HTTP route and imports `dist/plugin-sdk/reply-runtime.js`. It calls the real SDK `createReplyDispatcher`; it does not implement an alternative registry or dispatcher.

In each of five fresh Gateway processes per revision, HTTP requests create 16 abandoned dispatchers without `markComplete()`, four completed deliveries, and one held live delivery for which `markComplete()` has already been called. Only WeakRefs to abandoned and completed objects remain in the fixture. Eight GC turns precede observation.

Required counts, independently specified:

| Observation | Baseline | Candidate |
| --- | --- | --- |
| Abandoned turn contexts retained after GC | 16 | 0 |
| Abandoned dispatcher objects retained after GC | 16 | 0 |
| Completed turn contexts retained | 0 | 0 |
| Live turn context retained while delivery is held | 1 | 1 |
| Registry registrations while live delivery is held | 17 | 17 |
| Pending count while live delivery is held | 18 | 18 |
| Registrations after live settlement | 16 | 16 |
| Pending count after live settlement | 16 | 16 |
| Live context retained after settlement and GC | 0 | 0 |

The candidate behavioral assertion is `abandonedRetained === 0 && pending === 18`. It must fail on the baseline and pass on the candidate for all samples. A setup failure is neither baseline failure nor product evidence.

The first process for each revision also writes a synthetic heap snapshot. Constructor object counts and strong retainer paths must corroborate WeakRef observations, especially the baseline registry → callback → context → dispatcher options → synthetic turn path. Weak edges are excluded from graph traversal.

This is a reachability/count experiment, not a wall-time or total-heap performance benchmark. No memory-size improvement or incident growth rate is inferred. Builds are parallel isolated jobs; per-revision processes are serial, not interleaved ABAB. The missing-completion producer and orphaned restart reservations remain unresolved.

Gateway environments contain a fresh HOME, temporary synthetic config/state, PATH, and fixture paths only; no CI token, operator configuration, API key, external channel, or real model is provided. Public text evidence redacts IP addresses and credential-shaped strings. Raw snapshots remain separate synthetic audit artifacts.
