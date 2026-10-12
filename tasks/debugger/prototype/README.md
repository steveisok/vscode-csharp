# Browser CoreCLR prototype tools

**Maintained, local-only reproduction tools; not a portable-runtime acceptance claim.** The earlier macOS arm64 cohort completed the Small and Havit URL-helper stepping baseline. This source-only portability phase ran configuration/reporting tests, not a debugger pilot. Windows/Linux and macOS x64 are intended experimental hosts: they require matching ported native components and remain end-to-end unvalidated.

The canonical private build/source guide lives in the access-restricted [internal-components repository](https://dnceng.visualstudio.com/internal/_git/dotnet-diagnostics-internal-components), at `docs/wasm-debugger-experiments/README.md`. Its publication is coordinated separately; this link is a repository access entry, not a claim that the guide is on its default branch. Authorized developers obtain the matching runtime, Concord, BrowserDebugHost/proxy and app source revisions and build instructions there. Private implementation code is not included here.

## Build and prerequisites

Use the [published integration branch in Steve's fork](https://github.com/steveisok/vscode-csharp/tree/steveisok-wasm-debugger-prototype), which contains the maintained tools and extension fixes. No separate extension source patch is required. Pin the exact published commit recorded by the canonical guide instead of assuming this moving branch or another component's branch is a compatible cohort. This branch preserves Thays's prototype ancestry from `dev/thays/wasm_coreclr_debugger` at `31d0dfdc149c205b54c6f76c52beb52e6cd670c8`; that base is historical provenance, not the current reproduction checkout. The integration changes are published separately for coordination with Thays rather than implying they have landed in her fork.

```sh
git clone --branch steveisok-wasm-debugger-prototype https://github.com/steveisok/vscode-csharp.git
cd vscode-csharp
git rev-parse HEAD
```

```sh
npm ci --ignore-scripts
npm run packageDev
```

Provide existing local language-server components (`.roslyn`, `.roslynDevKit`, `.xamlTools`, `.testDiscovery`), extension assets and dependency extensions. If those are absent, follow the repository's explicit component restoration instructions; this launcher does not install them. Do not run release VSIX packaging for prototype staging: it deletes local component folders and restores the stock debugger.

Required host tools: Node 22+ (the accepted measurements used Node 24.15.0), an installed native VS Code executable, Edge or Chrome, the matching .NET/ASP.NET Core runtime for BrowserDebugHost, and `dotnet-serve` for the existing Small sample. The accepted host used .NET 10.0.301 SDK / 10.0.9 runtime; Havit's interpreted build used `12.0.100-alpha.1.26509.106`. These are provenance, not permission to combine incompatible packs. Browser versions, future build versions and exact source/asset hashes belong in the canonical manifest. Preflight checks file/config/cohort contracts, not whether a native loader actually runs.

Supply a local VS Code dependency-extension directory (for example the existing .NET runtime acquisition extension); VS Code supplies its JS debugger or a compatible local JS-debug extension can be supplied there. No downloads, global extension replacement or global VS Code settings edits occur in this launcher. The isolated profile records the configured `dotnet` for C# runtime acquisition, and the prototype proxy host bypasses acquisition using the same explicit native executable.

## Machine-local configuration versus portable provenance

Copy `localConfig.example.json` to `machine.local.json` in this directory and edit it. `*.local.json`, binaries, staging, profiles and run artifacts are ignored; **never commit machine paths, credentials, component packages or raw logs**.

The example contains role placeholders, not working artifact locations. Relative paths resolve from the config file's directory. `${configDir}`, `${home}`, `${extensionRoot}`, `${artifactRoot}` and earlier named `paths` fields (such as `${runtimeRoot}` and `${havitRoot}`) are supported; unknown tokens fail. Native paths with spaces are passed as individual `spawn`/`execFile` arguments, not shell commands. Use JSON-escaped native Windows paths on Windows.

`extensionRoot` is the isolated prototype checkout. `artifactRoot` must be inside that checkout's `out`; use a new area rather than the historic `out/wasm-prototype` captures. `profileRoot` is an explicitly chosen short private scratch area, never a real user VS Code profile. On long macOS worktree paths the example `${extensionRoot}/p` can still exceed the socket limit: choose a short dedicated native scratch path with an existing parent. Only newly allocated `r-<12 UUID hex>` profile directories are used; no global symlink is created, and Windows needs no symlink privilege. Profiles/raw logs are retained and referenced by `private-profile.json`, not copied into multiple giant archives.

`executables.vscode` and `executables.browser` may be omitted to probe a small set of host-specific known native installations. An explicit missing path always fails instead of selecting another installation. `dotnet` and `dotnetServe` require explicit file paths. Discovery does not install anything. Specify `browserType` matching the executable (`edge` or `chrome`).

The typed schema/validation is in [`prototypeConfig.ts`](prototypeConfig.ts). The machine config supplies:

| Field | Purpose |
|---|---|
| `manifest` | Complete artifact-cohort manifest supplied by the canonical owner |
| `paths.runtimeRoot`, `paths.havitRoot` | Local sources matching the PDB source checksums |
| `paths.runtimePack` | Whole matching interpreted browser runtime pack |
| `paths.concordPublish`, `paths.proxyPublish` | Whole native host / BrowserDebugHost publish directories |
| `paths.nativeAssets` | Matching host universal DAC/DBI and supplied companions |
| `paths.smallWebRoot`, `paths.havitWebRoot` | Whole published app webroots, never WASM-only overlays |
| `paths.smallHandoff`, `paths.havitHandoff` | Frozen owner readiness/source/PDB handoffs |
| `paths.havitServerModule` | Existing app `bench.mjs`; adapter imports **only** `startServer` |
| `paths.extensionDependencies` | Existing local VS Code dependency extensions |
| `sourceMaps.small`, `sourceMaps.havit` | PDB build roots mapped to the verified local source roots |
| `ports` | Distinct loopback Small/Havit/DAP/Electron-CDP ports |
| `allowUnvalidatedHost` | Explicit experimental opt-in; never grants missing-host artifacts or claims acceptance |

### Artifact-cohort manifest contract (schema version 1)

This is an asset contract; the canonical private guide separately owns repository origins, exact source revisions and build instructions. Historical patch digests are not substitutes for published reproduction commits. The guide does not promise byte-deterministic builds or downloadable historic binaries.

- `cohortId`: nonempty cohort label; `targetArchitecture`: exactly `wasm32`, separate from host architecture; `versions`: recorded string-valued tool/build versions.
- `hosts["darwin-arm64"|"darwin-x64"|"linux-x64"|"linux-arm64"|"win32-x64"|"win32-arm64"]`: only hosts with supplied artifacts. Each has `concord`, `proxy`, `native`, `endToEndValidated` and `features.wasmdbgArtifactDir`.
- Each artifact group is `{cohortId, files:[{path,size,sha256}]}`. Paths are safe relative paths; all file sizes/hashes and the complete directory file set are checked (a local `install.Lock` is exempt). Mixing old files into a new publish fails.
- `runtimePack`: the same complete asset group. `workloads.small` / `workloads.havit` each extend an asset group for the complete webroot with `assembly`, relative `appDll`, `appPdb`, `nativeWasm`, `handoffSha256` and `sourceFiles:[{path,sha256}]` relative to the corresponding source root. The app's target WASM hash must occur in the runtime pack. App source and handoff hashes must match, and `explicitRunnableHandoff` must be true without an owner hold.
- The host architecture/cohort is checked against native filenames; a missing host entry fails with a portability blocker instead of falling back to macOS. Signed/hash provenance does not replace a real Windows/Linux capability pilot.

| Host | Native DAP / Concord engine | Universal DBI / DAC |
|---|---|---|
| macOS | `vsdbg-ui` / `libvsdebugeng.impl.dylib` | `libmscordbi_universal.dylib` / `libmscordaccore_universal.dylib` |
| Linux | `vsdbg-ui` / `libvsdebugeng.impl.so` | `libmscordbi_universal.so` / `libmscordaccore_universal.so` |
| Windows | `vsdbg-ui.exe` / `vsdebugeng.impl.dll` | `mscordbi_universal.dll` / `mscordaccore_universal.dll` |

`amd64`/`x86_64` host aliases normalize to `x64`. These names are required inputs for an intended host; they do not assert that an available Unix prototype has already been ported. Unsupported OS/architecture combinations fail before staging.

## Commands (no Copilot required)

```sh
npm run prototype -- preflight --config tasks/debugger/prototype/machine.local.json
npm run prototype -- setup --config tasks/debugger/prototype/machine.local.json
npm run prototype -- open small --config tasks/debugger/prototype/machine.local.json
npm run prototype -- open havit --config tasks/debugger/prototype/machine.local.json
npm run prototype -- run small 1 capability --config tasks/debugger/prototype/machine.local.json
npm run prototype -- run havit 1 capability --config tasks/debugger/prototype/machine.local.json
npm run prototype -- run small 3 steps --config tasks/debugger/prototype/machine.local.json
npm run prototype -- run havit 3 steps --config tasks/debugger/prototype/machine.local.json
```

The common entry is [`prototype.js`](prototype.js); Bash is not required. `preflight` launches no process. `setup` creates a new ignored stage and launches no process. `open`/`run` deliberately stage a new generation rather than select an ambiguous “latest” directory or modify existing archives. A physical extension bundle/components copy is used on every host, not symlinks; VS Code debugger ownership and Windows privilege behavior are preserved. `runtimeDependencies=[]` in the generated development manifest excludes stock component downloads, and markers are added only for the actually supplied host package.

`open` owns the local app server, Concord DAP listener and private VS Code window. Select the staged debug configuration and F5. Closing the private window or interrupting the launcher cleans up owned helpers. POSIX helpers run in dedicated owned process groups; Windows uses `taskkill /PID <owned PID> /T` with escalation, never name-based killing. Occupied ports fail closed and other users' processes are untouched. There is no graceful-native-shutdown reliability claim.

`run` uses the same existing integration test and automatic UI inspection helpers, not a new benchmark harness. It accepts `<small|havit> <1..5> <steps|entry|capability>`; entry/capability require exactly one repetition. Reports, IDs, raw captures and failure handling are shared with `debuggerReports.ts`. Raw private VS Code logs have an explicit native-file URI and `private-profile.json` pointer when a short profile must live separately; proxy logs stay in the run directory. The new folder pattern is:

```text
artifactRoot/
  stage-<host>-<UUID>/                 # generated local extension/workspaces/config
  <workload>-<mode>-batch-<UTC>-<12UUIDhex>/
    README.md, report-metadata.json, cohort-provenance.json, measurement-summary.json
    <workload>-<mode>-run-<UTC>-<12UUIDhex>/
      README.md, report-metadata.json, raw JSON/logs/screenshots
      private-profile.json            # exact separate short profile/log location
      proxy-logs/                     # created by the feature-gated proxy
  report-registry/, README.md
```

## Readiness, normal stepping and measurement boundaries

Keep normal handshake, JMC and default implicit-evaluation policy. Small uses its actual Main user break and normal F10 15->16->17. Havit uses the opt-in **fully interpreted/no-R2R URL-helper primitive** scenario, not ordinary benchmark parity or the deferred async grid-filtering workload. Start `/components/HxGrid` without a fragment. After attach, app-module/configurationDone and first render, click the existing desktop “Filtering from headers” anchor once, Back, then Forward through that real history entry. Same-page fragment clicks alone skip .NET `LocationChanged`; ordinary history notification reaches the helper. Preparation 15->16->18 is untimed; measure only real F10 18->19->20. Do not step out of line 20.

The configured origin/port determines the expected real `url` and `hashIndex`, rather than a fabricated hardcoded scalar. Frozen source/PDB/owner handoffs and actual stop/Locals/UI observations are still required. A source manifest or schedule acknowledgement is not a real managed stop. A first capability pilot must pass before a repeated headline batch. Readiness response failures remain loud at 10s; automatic inspection is bounded at 30s with 300ms quiet and 25ms polling. Visible refresh includes quiescence/poll/capture overhead. No duplicate explicit inspection, Watch or expansion is added. Absence of completion markers is not proof that no implicit evaluation happened.

The maintained runner requires a passed individual capability report in the same artifact area for the **same selected workload, host and exact hashed cohort** before `steps` mode. Old macOS results or an owner source-readiness flag do not grant a new host/cohort measurement gate. Changing any app/PDB/native/proxy hash requires its own capability pilot. This phase intentionally generated no such new acceptance record.

Report n/min/median/max; no p95 from six points. App statement CPU remains included, request sums overlap, transport reads include waiting. Do not compare independent OS cohorts in lockstep or infer a regression/root cause from unvalidated cross-host observations.

## Portable proxy logs: new source only

The private proxy owner's option is `WASMDBG_ARTIFACT_DIR`, an absolute native-host directory, selected once per host process. The launcher passes a dedicated fresh `run/proxy-logs` via `VSCODE_CSHARP_WASMDBG_ARTIFACT_DIR`; only the extension's proxy child translates it to the actual option. Existing `WASMDBG_LOGGING` / `WASMDBG_PERFORMANCE_LOGGING` enable flags are unchanged; the path option does not enable logging. The proxy creates the directory and rejects reused log names, relative/foreign paths and write failures, with no silent fallback.

**The accepted proxy `250aea...` / host `41855...` does not implement that new option.** Its historical `C:\diag` literal log names remain untouched. A portable run requires the portable-log source revision identified by the private guide, a **new complete host/proxy publish**, new exact hashes and `features.wasmdbgArtifactDir=true`. Preflight rejects the old/unknown feature rather than pretending the environment works with old binaries. That new source is unmeasured in this phase.

## Remaining reproducibility gaps

The canonical guide and private component sources require internal access; their publication is coordinated independently of this public extension branch. Durable download/retention of historic binary cohorts and raw 2GB archives is not established; obtain/build matching component inputs explicitly rather than assume a remote artifact service. Windows/Linux native portability, process behavior, Electron UI capture, browser setup, dependency packaging and actual source stepping need their own owned pilot before any acceptance/performance claim. Configuration tests do not close those gaps.

The existing measurements/raw archive hashes are preserved; no benchmark, server, debugger, native/app build or global configuration change was performed in this documentation/configuration phase.
