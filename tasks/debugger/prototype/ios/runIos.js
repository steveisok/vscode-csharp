/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// iOS Simulator CoreCLR workload for the prototype runner. Unlike the browser workloads there is no Concord,
// proxy or browser: the shipped C# extension vsdbg debugs the app through the vsdbgremotecoreclrhost (osx) /
// vsdbgremotecoreclrtarget (iossimulator) pair that the .NET MAUI extension stages. A cohort is either the
// MAUI extension's shipped pair or a locally built pair swapped into an isolated copy of the extension.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const toolRoot = path.resolve(__dirname, '../../../..');
const reports = () => require(path.join(toolRoot, 'out/test/lsptoolshost/integrationTests/debuggerReports.js'));
const { parseDebuggerWorkload } = require(path.join(toolRoot, 'out/test/lsptoolshost/integrationTests/debuggerWorkload.js'));
const { OwnedProcesses } = require(path.join(toolRoot, 'out/tasks/debugger/prototype/ownedProcesses.js'));

const MAUI = 'ms-dotnettools.dotnet-maui';
const CSHARP = 'ms-dotnettools.csharp';
const REQUIRED_EXTENSIONS = [CSHARP, 'ms-dotnettools.csdevkit', MAUI, 'ms-dotnettools.vscode-dotnet-runtime'];
const HOST_NAMES = ['libvsdbgremotecoreclrhost.dylib', 'libremotemscordbihost.dylib'];
const TARGET_NAME = 'libvsdbgremotecoreclrtarget.dylib';
const RUNTIME_NATIVE = ['libcoreclr.dylib', 'libmscordbi.dylib', 'libmscordaccore.dylib', 'libclrjit.dylib'];

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function expand(value, tokens) {
    return value.replace(/\$\{([a-zA-Z]+)\}/g, (_, name) => {
        if (!(name in tokens)) throw Error(`Unknown token \${${name}} in iOS config.`);
        return tokens[name];
    });
}
function loadIosConfig(filename) {
    const raw = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (raw.schemaVersion !== 1 || raw.kind !== 'ios') throw Error('Expected an iOS prototype config (schemaVersion 1, kind ios).');
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('The iOS Simulator experiment is defined for macOS arm64 hosts only.');
    const configDir = path.dirname(path.resolve(filename));
    const tokens = { configDir, home: os.homedir() };
    const resolve = (value) => path.resolve(configDir, expand(value, tokens));
    const config = { ...raw, configFile: path.resolve(filename) };
    for (const key of ['extensionRoot', 'artifactRoot', 'profileRoot', 'stageRoot']) {
        config[key] = resolve(raw[key]);
        tokens[key] = config[key];
    }
    config.paths = Object.fromEntries(Object.entries(raw.paths).map(([k, v]) => [k, resolve(v)]));
    config.executables = Object.fromEntries(Object.entries(raw.executables).map(([k, v]) => [k, resolve(v)]));
    if (!['shipped', 'built'].includes(config.cohort)) throw Error('cohort must be shipped or built.');
    if (config.cohortLabel !== undefined && !/^[a-z0-9-]+$/.test(config.cohortLabel)) throw Error('cohortLabel must be [a-z0-9-]+.');
    config.extraBundleFiles = (raw.extraBundleFiles ?? []).map((extra) => {
        const source = resolve(extra.source);
        if (!fs.existsSync(source)) throw Error(`Missing extra bundle file ${source}.`);
        if (typeof extra.relativePath !== 'string' || path.isAbsolute(extra.relativePath) || extra.relativePath.includes('..'))
            throw Error('extraBundleFiles relativePath must be bundle-relative.');
        return { source, relativePath: extra.relativePath };
    });
    if (config.appEnvironment !== undefined) {
        for (const [key, value] of Object.entries(config.appEnvironment)) {
            if (!/^[A-Z0-9_]+$/.test(key) || typeof value !== 'string' || /[\n'"]/.test(value))
                throw Error(`Invalid appEnvironment entry ${key}.`);
        }
    }
    if (!/^[0-9A-F-]{36}$/.test(config.simulator?.udid ?? '')) throw Error('simulator.udid must be an explicit simulator UDID.');
    if (!config.runtimePack?.version || !config.runtimePack?.id) throw Error('runtimePack id/version required.');
    for (const [name, file] of Object.entries(config.executables)) {
        if (!fs.existsSync(file)) throw Error(`Missing ${name} executable ${file}; nothing is discovered or installed.`);
    }
    for (const name of ['workloadSource', 'extensions', 'nugetConfig', 'nugetPackages', 'runtimePackFeed']) {
        if (!config.paths[name]) throw Error(`paths.${name} required.`);
    }
    if (config.cohort === 'built') {
        for (const name of ['builtHost', 'builtTarget']) {
            if (!config.paths[name] || !fs.existsSync(config.paths[name])) throw Error(`Built cohort requires paths.${name}.`);
        }
    }
    if (!config.artifactRoot.startsWith(config.extensionRoot + path.sep + 'out' + path.sep)) {
        throw Error('artifactRoot must be inside the runner checkout out/ directory.');
    }
    return config;
}
function extensionFolder(root, id) {
    const matches = fs.readdirSync(root).filter((name) => name.toLowerCase().startsWith(id + '-'));
    if (matches.length !== 1) throw Error(`Expected exactly one ${id} in ${root}, found ${matches.length}.`);
    return path.join(root, matches[0]);
}
function mauiResources(extensions) {
    return path.join(extensionFolder(extensions, MAUI), 'dist/resources');
}
function cloneCopy(source, destination) {
    fs.cpSync(source, destination, {
        recursive: true,
        dereference: true,
        errorOnExist: true,
        force: false,
        mode: fs.constants.COPYFILE_FICLONE,
    });
}
function runtimePackDirectory(config) {
    return path.join(config.paths.nugetPackages, config.runtimePack.id.toLowerCase(), config.runtimePack.version);
}
function cohortInventory(config, stage) {
    const extensions = path.join(stage, 'extensions');
    const resources = mauiResources(extensions);
    const csharp = extensionFolder(extensions, CSHARP);
    const inventory = {
        cohortId: `ios-${config.cohortLabel ?? config.cohort}`,
        hostDylib: sha256(path.join(resources, 'VsdbgRemoteCoreclrHost/osx-arm64', HOST_NAMES[0])),
        hostLegacyNameDylib: sha256(path.join(resources, 'VsdbgRemoteCoreclrHost/osx-arm64', HOST_NAMES[1])),
        targetDylib: sha256(path.join(resources, 'VsdbgRemoteCoreclrTarget/ios/iossimulator-arm64', TARGET_NAME)),
        vsdbgEngine: sha256(path.join(csharp, '.debugger/arm64/libvsdebugeng.impl.dylib')),
        mauiExtensionBundle: sha256(path.join(extensionFolder(extensions, MAUI), 'dist/extension.js')),
        csharpExtensionBundle: sha256(path.join(csharp, 'dist/extension.js')),
        workloadSource: sha256(path.join(stage, 'workspace/IosDebuggee/OrderProcessor.cs')),
    };
    const pack = path.join(runtimePackDirectory(config), 'runtimes/iossimulator-arm64');
    if (fs.existsSync(pack)) {
        inventory.runtimePack = Object.fromEntries(
            [...RUNTIME_NATIVE.map((f) => `native/${f}`), 'lib/net11.0/System.Private.CoreLib.dll']
                .map((f) => [f, path.join(pack, f)])
                .filter(([, file]) => fs.existsSync(file))
                .map(([name, file]) => [name, sha256(file)])
        );
    }
    const extras = path.join(stage, 'bundle-extra');
    if (fs.existsSync(extras)) {
        inventory.extraBundleFiles = Object.fromEntries(fs.readdirSync(extras).map((f) => [f, sha256(path.join(extras, f))]));
    }
    if (config.appEnvironment && Object.keys(config.appEnvironment).length) {
        inventory.appEnvironment = Object.entries(config.appEnvironment).map(([k, v]) => `${k}=${v}`).sort().join(';');
    }
    if (config.runtimeLocalPatchSha256) inventory.runtimeLocalPatch = config.runtimeLocalPatchSha256;
    return inventory;
}
function stageIos(config) {
    // Stage under a short root: the shipped vsdbg-ui fails to initialize CoreCLR (8ede002b) once its
    // .debugger/<arch> directory path reaches 178 characters (file paths past ~255). Results stay in artifactRoot.
    fs.mkdirSync(config.stageRoot, { recursive: true });
    const stage = path.join(config.stageRoot, `s-${config.cohort}-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`);
    fs.mkdirSync(stage);
    // Isolated extensions copy; the user's VS Code extensions are never modified.
    const extensions = path.join(stage, 'extensions');
    fs.mkdirSync(extensions);
    const sourceList = JSON.parse(fs.readFileSync(path.join(config.paths.extensions, 'extensions.json'), 'utf8'));
    const list = [];
    for (const id of REQUIRED_EXTENSIONS) {
        const entry = sourceList.find((e) => e.identifier.id === id);
        if (!entry) throw Error(`Isolated extension source lacks ${id}.`);
        cloneCopy(path.join(config.paths.extensions, entry.relativeLocation), path.join(extensions, entry.relativeLocation));
        list.push({ ...entry, location: { $mid: 1, path: path.join(extensions, entry.relativeLocation), scheme: 'file' } });
    }
    fs.writeFileSync(path.join(extensions, 'extensions.json'), JSON.stringify(list));
    const longest = (directory) =>
        fs.readdirSync(directory, { withFileTypes: true }).reduce((max, entry) => {
            const file = path.join(directory, entry.name);
            return Math.max(max, entry.isDirectory() && !entry.isSymbolicLink() ? longest(file) : file.length);
        }, directory.length);
    const longestPath = longest(path.join(extensionFolder(extensions, CSHARP), '.debugger'));
    if (longestPath > 255) throw Error(`Staged vsdbg path length ${longestPath} exceeds 255; use a shorter stageRoot.`);
    // C# Dev Kit caches absolute component paths in its own folder; a copied cache would run the user's binaries.
    const devKitCache = path.join(extensionFolder(extensions, 'ms-dotnettools.csdevkit'), 'cache');
    fs.rmSync(devKitCache, { recursive: true, force: true });
    const resources = mauiResources(extensions);
    const swaps = [];
    if (config.cohort === 'built') {
        for (const name of HOST_NAMES) {
            const file = path.join(resources, 'VsdbgRemoteCoreclrHost/osx-arm64', name);
            swaps.push({ file: path.relative(stage, file), shipped: sha256(file), built: sha256(config.paths.builtHost) });
            fs.rmSync(file);
            fs.copyFileSync(config.paths.builtHost, file);
        }
        const target = path.join(resources, 'VsdbgRemoteCoreclrTarget/ios/iossimulator-arm64', TARGET_NAME);
        swaps.push({ file: path.relative(stage, target), shipped: sha256(target), built: sha256(config.paths.builtTarget) });
        fs.rmSync(target);
        fs.copyFileSync(config.paths.builtTarget, target);
    }
    // Workspace: the guide's workload app plus experiment-local NuGet and runtime-pack selection.
    const workspace = path.join(stage, 'workspace');
    cloneCopy(config.paths.workloadSource, workspace);
    for (const generated of ['bin', 'obj']) fs.rmSync(path.join(workspace, 'IosDebuggee', generated), { recursive: true, force: true });
    fs.copyFileSync(config.paths.nugetConfig, path.join(workspace, 'nuget.config'));
    const sdkVersion = execFileSync(config.executables.dotnet, ['--version'], { cwd: os.tmpdir(), encoding: 'utf8' }).trim();
    fs.writeFileSync(
        path.join(workspace, 'global.json'),
        JSON.stringify({ sdk: { version: sdkVersion, rollForward: 'disable', paths: [path.dirname(config.executables.dotnet)] } }, null, 2)
    );
    // Optional extra native files placed in the app bundle (e.g. the cDAC beside libmscordaccore), the same way the
    // MAUI extension adds the remote-debugger target: ResolvedFileToPublish before _ComputePublishLocation.
    const extraBundleFiles = [];
    for (const extra of config.extraBundleFiles ?? []) {
        const staged = path.join(stage, 'bundle-extra', path.basename(extra.source));
        fs.mkdirSync(path.dirname(staged), { recursive: true });
        fs.copyFileSync(extra.source, staged);
        extraBundleFiles.push({ relativePath: extra.relativePath, staged, sha256: sha256(staged) });
    }
    const extraTarget = extraBundleFiles.length
        ? `  <Target Name="_IosPrototypeExtraBundleFiles" BeforeTargets="_ComputePublishLocation">\n    <ItemGroup>\n${extraBundleFiles
              .map(
                  (f) =>
                      `      <ResolvedFileToPublish Include="${f.staged}" RelativePath="${f.relativePath}" PublishFolderType="DynamicLibrary" Kind="Dynamic" />`
              )
              .join('\n')}\n    </ItemGroup>\n  </Target>\n`
        : '';
    fs.writeFileSync(
        path.join(workspace, 'IosDebuggee/runtime-pack.local.props'),
        `<Project>\n  <!-- Generated by the iOS prototype stager: locally built ${config.runtimePack.id}. -->\n  <ItemGroup>\n    <KnownFrameworkReference Update="Microsoft.NETCore.App">\n      <LatestRuntimeFrameworkVersion Condition="'%(TargetFramework)' == 'net11.0'">${config.runtimePack.version}</LatestRuntimeFrameworkVersion>\n    </KnownFrameworkReference>\n  </ItemGroup>\n${extraTarget}</Project>\n`
    );
    fs.mkdirSync(path.join(workspace, '.vscode'));
    fs.writeFileSync(
        path.join(workspace, '.vscode/settings.json'),
        JSON.stringify({ 'dotnet.defaultSolution': 'IosDebuggee.slnx' }, null, 2)
    );
    for (const helper of ['captureUi.js', 'uiInspectAction.js']) {
        fs.copyFileSync(path.join(__dirname, '..', helper), path.join(stage, helper));
    }
    const harness = path.join(stage, 'harness');
    fs.mkdirSync(harness);
    fs.copyFileSync(path.join(__dirname, 'harness-package.json'), path.join(harness, 'package.json'));
    fs.mkdirSync(path.join(stage, 'workloads'));
    const template = parseDebuggerWorkload(JSON.parse(fs.readFileSync(path.join(__dirname, '../workloads/ios.json'), 'utf8')));
    fs.writeFileSync(path.join(stage, 'workloads/ios.json'), JSON.stringify(template, null, 2));
    fs.writeFileSync(
        path.join(workspace, 'runtime-handoff.json'),
        JSON.stringify(
            {
                explicitRunnableHandoff: true,
                cohort: config.cohort,
                runtimePack: config.runtimePack,
                simulator: config.simulator,
                swaps,
            },
            null,
            2
        )
    );
    fs.writeFileSync(
        path.join(stage, 'stage-manifest.json'),
        JSON.stringify({ cohort: config.cohort, cohortLabel: config.cohortLabel, swaps, extraBundleFiles, appEnvironment: config.appEnvironment ?? {}, longestStagedDebuggerPath: longestPath, createdAt: new Date().toISOString(), cloneCopies: true, noSymlinks: true }, null, 2)
    );
    return stage;
}
function childEnvironment(config) {
    const sdk = path.dirname(config.executables.dotnet);
    const env = {
        ...process.env,
        PATH: `${sdk}:${process.env.PATH}`,
        DOTNET_ROOT: sdk,
        DOTNET_CLI_HOME: config.paths.dotnetCliHome ?? path.join(path.dirname(sdk), 'cli-home'),
        NUGET_PACKAGES: config.paths.nugetPackages,
        DOTNET_MULTILEVEL_LOOKUP: '0',
        DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false',
        DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: 'false',
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_NOLOGO: '1',
        DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    };
    delete env.MSBuildExtensionsPath;
    delete env.MSBUILD_EXE_PATH;
    return env;
}
function simctl(...args) {
    return spawnSync('xcrun', ['simctl', ...args], { encoding: 'utf8' });
}
function prepareSimulator(config, run) {
    const udid = config.simulator.udid;
    const bundle = config.simulator.bundleId;
    const record = { udid, bundle, steps: [] };
    const boot = simctl('bootstatus', udid, '-b');
    record.steps.push({ step: 'bootstatus -b', status: boot.status, out: boot.stdout.slice(-400), err: boot.stderr.slice(-400) });
    if (boot.status !== 0) throw Error(`Simulator ${udid} did not boot: ${boot.stderr}`);
    for (const step of [['terminate', udid, bundle], ['uninstall', udid, bundle]]) {
        const result = simctl(...step);
        record.steps.push({ step: step.join(' '), status: result.status, err: result.stderr.slice(-400) });
    }
    const info = JSON.parse(simctl('list', 'devices', '-j').stdout);
    record.device = Object.entries(info.devices).flatMap(([runtime, devices]) => devices.map((d) => ({ runtime, ...d }))).find((d) => d.udid === udid);
    fs.writeFileSync(path.join(run, 'simulator-preparation.json'), JSON.stringify(record, null, 2), { flag: 'wx' });
    return record;
}
async function freePort(port) {
    const listener = net.createServer();
    await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(port, '127.0.0.1', () => listener.close(resolve));
    });
}
function createProfile(config) {
    fs.mkdirSync(config.profileRoot, { recursive: true });
    const directory = path.join(config.profileRoot, `r-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`);
    fs.mkdirSync(path.join(directory, 'User'), { recursive: true });
    fs.writeFileSync(
        path.join(directory, 'User/settings.json'),
        JSON.stringify(
            {
                'telemetry.telemetryLevel': 'off',
                'workbench.startupEditor': 'none',
                'extensions.autoUpdate': false,
                'extensions.autoCheckUpdates': false,
                'update.mode': 'none',
                'security.workspace.trust.enabled': false,
                'chat.disableAIFeatures': true,
                // Diagnostic MAUI output (build binlog) and launch.json values honored; no XAML tooling for this non-XAML app.
                'maui.configuration.logVerbosity': 'diagnostic',
                'maui.configuration.debugVerbosity': 'diagnostic',
                'maui.configuration.useLaunchJsonConfigurations': true,
                'dotnet.debug.hotReloadXAML': false,
                // The VS Code process resolves the login-shell PATH, so select the isolated SDK explicitly.
                'dotnetAcquisitionExtension.existingDotnetPath': ['ms-dotnettools.csharp', 'ms-dotnettools.csdevkit', 'ms-dotnettools.dotnet-maui'].map(
                    (extensionId) => ({ extensionId, path: config.executables.dotnet })
                ),
                ...(config.vscodeSettings ?? {}),
            },
            null,
            2
        )
    );
    return directory;
}
function versionsRecord(config, stage) {
    const extensions = path.join(stage, 'extensions');
    const read = (id) => JSON.parse(fs.readFileSync(path.join(extensionFolder(extensions, id), 'package.json'), 'utf8')).version;
    const tool = (cmd, args) => {
        try {
            return execFileSync(cmd, args, { encoding: 'utf8' }).trim().split('\n')[0];
        } catch (error) {
            return `unavailable: ${error.message}`;
        }
    };
    return {
        node: process.version,
        host: 'darwin-arm64',
        target: 'iossimulator-arm64',
        cohort: config.cohort,
        vscode: tool(config.executables.vscodeCli ?? config.executables.vscode, ['--version']),
        csharpExtension: read(CSHARP),
        csdevkitExtension: read('ms-dotnettools.csdevkit'),
        mauiExtension: read(MAUI),
        dotnetSdk: tool(config.executables.dotnet, ['--version']),
        xcode: tool('xcodebuild', ['-version']).replace(/\s+/g, ' '),
        runtimePack: `${config.runtimePack.id} ${config.runtimePack.version}`,
        simulatorRuntime: config.simulator.runtime ?? 'see simulator-preparation.json',
        platformAcceptance: 'unvalidated experimental host (iOS Simulator CoreCLR remote debugger)',
    };
}
function hashAppBundle(stage) {
    const app = path.join(stage, 'workspace/IosDebuggee/bin/Debug/net11.0-ios/iossimulator-arm64/IosDebuggee.app');
    if (!fs.existsSync(app)) return { present: false };
    const files = {};
    for (const name of ['IosDebuggee.dll', 'IosDebuggee.pdb', TARGET_NAME, ...RUNTIME_NATIVE, 'System.Private.CoreLib.dll']) {
        const file = path.join(app, name);
        files[name] = fs.existsSync(file) ? sha256(file) : 'absent';
    }
    // Bundled dylibs are re-signed, so provenance is the embedded runtime commit rather than pack bytes.
    const commits = {};
    for (const name of RUNTIME_NATIVE.filter((n) => n !== 'libclrjit.dylib')) {
        const file = path.join(app, name);
        const match = fs.existsSync(file) ? fs.readFileSync(file).toString('latin1').match(/@Commit: ([0-9a-f]{40})/) : null;
        commits[name] = match ? match[1] : 'absent';
    }
    return { present: true, files, commits };
}

function ownedGroupMembers(groups) {
    const ps = spawnSync('ps', ['-ax', '-o', 'pid=,pgid='], { encoding: 'utf8' });
    return ps.stdout
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter(([pid, pgid]) => pid && groups.has(pgid) && Number(pid) !== process.pid)
        .map(([pid]) => Number(pid));
}
async function stopOwnedGroupMembers(groups) {
    const record = { signalled: [], errors: [], remaining: [] };
    for (const signal of ['SIGTERM', 'SIGKILL']) {
        for (const pid of ownedGroupMembers(groups)) {
            try {
                process.kill(pid, signal);
                record.signalled.push({ pid, signal });
            } catch (error) {
                if (error.code !== 'ESRCH') record.errors.push({ pid, signal, error: String(error) });
            }
        }
        const deadline = Date.now() + 10000;
        while (ownedGroupMembers(groups).length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
        if (!ownedGroupMembers(groups).length) break;
    }
    record.remaining = ownedGroupMembers(groups);
    return record;
}
function findFiles(directory, pattern) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? findFiles(file, pattern) : pattern.test(entry.name) ? [file] : [];
    });
}
// Post-run cDAC evidence from retained logs: app environment as launched, ordered [cDAC]/CORDBG stderr lines,
// unique fallbacks and (capability runs) the workflow phase + DAP request in flight for each timestamped line.
function extractCdacEvidence(run) {
    const mlaunchLogs = findFiles(path.join(run, 'vscode-logs'), /^mlaunch-.*\.log$/);
    const text = mlaunchLogs.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const lines = text.split('\n');
    const appEnvironmentAsLaunched = lines.filter((l) => /SIMCTL_CHILD_/.test(l)).map((l) => l.trim());
    const stderr = lines.filter((l) => /\[cDAC\]|CORDBG|cdac/i.test(l)).map((l) => l.replace(/^\[stderr\]\s*/, '').trim());
    const fallbacks = {};
    for (const line of stderr) {
        const m = line.match(/\[cDAC\] (Allowed|Blocked) fallback: (\S+) at (\S+):(\d+)/);
        if (!m) continue;
        const key = `${m[1]} ${m[2]} ${m[3]}:${m[4]}`;
        fallbacks[key] ??= { kind: m[1], method: m[2], file: m[3], line: Number(m[4]), count: 0, actions: [] };
        fallbacks[key].count++;
    }
    const attachFile = path.join(run, 'managed-attach-result.json');
    const attach = fs.existsSync(attachFile) ? JSON.parse(fs.readFileSync(attachFile, 'utf8')) : undefined;
    const correlated = [];
    if (attach?.appStderrEvents?.length) {
        const stops = attach.messages.filter((e) => e.message.type === 'event' && e.message.event === 'stopped');
        const requests = [...attach.timedRequests].sort((a, b) => a.startedAt - b.startedAt);
        const uiAction = (name) => {
            const f = path.join(run, `${name}.json`);
            return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).actionEpochMs - attach.epochOffsetMs : undefined;
        };
        const selectAt = uiAction('inspect-select-caller');
        const expandAt = uiAction('inspect-expand-caller-this');
        for (const event of attach.appStderrEvents) {
            let phase = 'launch/attach (before the first managed stop)';
            stops.forEach((stop, index) => {
                if (event.at >= stop.at) phase = `automatic Locals/stack at stop ${index} (line ${stop.message.body?.line ?? '?'})`;
            });
            if (selectAt !== undefined && event.at >= selectAt) phase = 'select caller frame / load caller Locals';
            if (expandAt !== undefined && event.at >= expandAt) phase = 'expand caller this';
            const request = requests.filter((r) => r.startedAt <= event.at).pop();
            const item = {
                atMs: event.atMs,
                line: event.line.replace(/^\[stderr\]\s*/, '').trim(),
                phase,
                lastDapRequest: request ? { command: request.command, sequence: request.sequence, arguments: request.arguments } : undefined,
            };
            correlated.push(item);
            const m = item.line.match(/\[cDAC\] (Allowed|Blocked) fallback: (\S+) at (\S+):(\d+)/);
            if (m) {
                const entry = fallbacks[`${m[1]} ${m[2]} ${m[3]}:${m[4]}`];
                if (entry && !entry.actions.includes(phase)) entry.actions.push(phase);
            }
        }
    }
    const evidence = {
        mlaunchLogs: mlaunchLogs.map((f) => path.relative(run, f)),
        appEnvironmentAsLaunched,
        stderrLines: stderr,
        uniqueFallbacks: Object.values(fallbacks),
        blockedFallbackCount: Object.values(fallbacks).filter((f) => f.kind === 'Blocked').length,
        timestamped: Boolean(attach?.appStderrTimestamped),
        correlated,
        loadedImages: attach?.loadedImages,
        failure: attach?.failure,
    };
    fs.writeFileSync(path.join(run, 'cdac-evidence.json'), JSON.stringify(evidence, null, 2));
    return evidence;
}
async function runIos(options) {
    const { config, repetitions, mode } = options;
    const R = reports();
    const stage = stageIos(config);
    const env = childEnvironment(config);
    // Untimed restore/compile warm-up so per-run MAUI builds are incremental; failures are preserved, not retried.
    const warm = spawnSync(
        config.executables.dotnet,
        ['build', path.join(stage, 'workspace/IosDebuggee/IosDebuggee.csproj'), '-c', 'Debug', '-f', 'net11.0-ios', '-r', 'iossimulator-arm64', '-bl:' + path.join(stage, 'warm-build.binlog')],
        { cwd: path.join(stage, 'workspace'), env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    fs.writeFileSync(path.join(stage, 'warm-build.log'), `${warm.stdout}\n${warm.stderr}\nEXIT=${warm.status}\n`);
    if (warm.status !== 0) throw Error(`Untimed warm-up build failed; see ${path.join(stage, 'warm-build.log')}`);
    const cohort = cohortInventory(config, stage);
    const workloadName = `ios-${config.cohortLabel ?? config.cohort}`;
    const artifactRoot = config.artifactRoot;
    if (mode === 'steps' && !R.hasMatchingCapability(artifactRoot, workloadName, cohort, 'darwin-arm64')) {
        throw Error(`Run ios 1 capability first for the exact ${workloadName} cohort in this artifact area.`);
    }
    const versions = versionsRecord(config, stage);
    const identity = R.allocateReportDirectory(artifactRoot, workloadName, mode);
    const batch = path.join(artifactRoot, identity.directory);
    fs.mkdirSync(path.join(batch, 'provenance'));
    fs.copyFileSync(config.configFile, path.join(batch, 'provenance/ios.local.json'));
    fs.copyFileSync(path.join(stage, 'stage-manifest.json'), path.join(batch, 'provenance/stage-manifest.json'));
    fs.copyFileSync(path.join(stage, 'workspace/runtime-handoff.json'), path.join(batch, 'provenance/runtime-handoff.json'));
    fs.copyFileSync(path.join(stage, 'warm-build.log'), path.join(batch, 'provenance/warm-build.log'));
    const batchReport = {
        ...identity,
        workload: workloadName,
        scenario: 'iOS Simulator CoreCLR, .NET MAUI F5, OrderProcessor Debugger.Break',
        mode,
        status: 'incomplete',
        startedAt: identity.generatedAt,
        finishedAt: null,
        cohort,
        versions,
        requestedRuns: repetitions,
        completedRuns: 0,
        completedSteps: 0,
        links: [],
    };
    R.writeReport(artifactRoot, batchReport, []);
    const all = [];
    const runReports = [];
    let suiteFailed = false;
    const workload = JSON.parse(fs.readFileSync(path.join(stage, 'workloads/ios.json'), 'utf8'));
    try {
        for (let index = 0; index < repetitions; index++) {
            const runIdentity = R.allocateReportDirectory(artifactRoot, workloadName, mode, identity);
            const run = path.join(artifactRoot, runIdentity.directory);
            const runReport = {
                ...runIdentity,
                workload: workloadName,
                scenario: batchReport.scenario,
                mode,
                status: 'incomplete',
                label: `Run ${index + 1}`,
                startedAt: runIdentity.generatedAt,
                finishedAt: null,
                cohort,
                versions,
                links: [],
                completedSteps: 0,
            };
            runReports.push(runReport);
            R.writeReport(artifactRoot, runReport, []);
            const owned = new OwnedProcesses();
            let profile;
            let runSamples = [];
            try {
                await freePort(config.ports.ui);
                prepareSimulator(config, run);
                profile = createProfile(config);
                fs.writeFileSync(path.join(run, 'private-profile.json'), JSON.stringify({ profile, owned: true }, null, 2));
                const testEnv = {
                    ...env,
                    CODE_EXTENSIONS_PATH: config.extensionRoot,
                    TEST_FILE_FILTER: path.join(config.extensionRoot, 'test/lsptoolshost/integrationTests/iosCoreClr.integration.test.ts'),
                    WASM_PROTOTYPE_DIRECTORY: stage,
                    WASM_PROTOTYPE_RUN_DIRECTORY: run,
                    WASM_PROTOTYPE_BATCH_ID: identity.batchId,
                    WASM_PROTOTYPE_RUN_ID: runIdentity.runId,
                    WASM_PROTOTYPE_WORKLOAD: 'ios',
                    WASM_PROTOTYPE_STEP_CAPABILITIES: '1',
                    WASM_PROTOTYPE_MEASUREMENT_ENABLED: mode === 'steps' ? '1' : '0',
                    WASM_PROTOTYPE_EXTENDED_ACTIONS: config.extendedInspection ? '1' : '0',
                    WASM_PROTOTYPE_CLOSING_ACTION: 'none',
                    WASM_PROTOTYPE_UI_PORT: String(config.ports.ui),
                    WASM_PROTOTYPE_NODE: process.execPath,
                    IOS_PROTOTYPE_DEVICE: config.simulator.udid,
                    IOS_PROTOTYPE_PROFILE: profile,
                    IOS_PROTOTYPE_APP_ENV: JSON.stringify(config.appEnvironment ?? {}),
                    IOS_PROTOTYPE_TAIL_APP_STDERR: mode === 'capability' ? '1' : '0',
                    ...(config.projectSettleMs ? { IOS_PROTOTYPE_PROJECT_SETTLE_MS: String(config.projectSettleMs) } : {}),
                };
                const testLaunch = {
                    vscodeExecutablePath: config.executables.vscode,
                    extensionDevelopmentPath: path.join(stage, 'harness'),
                    extensionTestsPath: path.join(config.extensionRoot, 'out/test/lsptoolshost/integrationTests/index.js'),
                    launchArgs: [
                        path.join(stage, 'workspace'),
                        '--new-window',
                        '--disable-workspace-trust',
                        '--skip-welcome',
                        '--skip-release-notes',
                        '--disable-extension',
                        'github.copilot-chat',
                        // Keep the runner's process-local PATH (isolated SDK first) instead of the login-shell PATH.
                        '--force-disable-user-env',
                        `--remote-debugging-port=${config.ports.ui}`,
                        '--user-data-dir',
                        profile,
                        '--extensions-dir',
                        path.join(stage, 'extensions'),
                        ...(mode === 'capability' ? ['--log', 'trace'] : []),
                    ],
                    extensionTestsEnv: testEnv,
                };
                const testFile = path.join(run, 'test-launch.json');
                fs.writeFileSync(testFile, JSON.stringify(testLaunch, null, 2));
                const fd = fs.openSync(path.join(run, 'test-console.log'), 'w');
                const tests = owned.spawn(process.execPath, [path.join(__dirname, '..', 'launchTests.js'), testFile], {
                    cwd: run,
                    env,
                    stdio: ['ignore', fd, fd],
                });
                fs.closeSync(fd);
                await new Promise((resolve, reject) => {
                    tests.once('error', reject);
                    tests.once('close', (code, signal) =>
                        code === 0 ? resolve() : reject(Error(`Owned integration runner failed: ${code}/${signal}; see test-console.log`))
                    );
                });
                const result = JSON.parse(fs.readFileSync(path.join(run, 'automatic-step-results.json'), 'utf8'));
                const attach = JSON.parse(fs.readFileSync(path.join(run, 'managed-attach-result.json'), 'utf8'));
                if (attach.stepCapabilitiesCheckPassed !== true || attach.failure) throw Error('Automatic iOS capability did not pass.');
                runSamples = result.steps;
                if (runSamples.length !== workload.stops.length - 1 || result.measurementEnabled !== (mode === 'steps')) {
                    throw Error('Automatic step capture is incomplete or has the wrong measurement mode.');
                }
                if (config.extendedInspection && (!result.extendedActions || !result.extendedActions.callerInspection?.expandCallerThis)) {
                    throw Error('Workflow-mode caller inspection is incomplete.');
                }
                if (mode === 'steps') R.timingDistributions(runSamples);
                all.push(...runSamples.map((step) => ({ batchId: identity.batchId, runId: runIdentity.runId, run: index + 1, ...step })));
                runReport.status = 'passed';
                runReport.completedSteps = runSamples.length;
            } catch (error) {
                fs.writeFileSync(path.join(run, 'run-failure.txt'), String(error));
                suiteFailed = true;
                runReport.status = 'failed';
                runReport.failure = String(error);
                batchReport.failure = String(error);
                throw error;
            } finally {
                let cleanupFailure;
                const ps = spawnSync('ps', ['-ax', '-o', 'pid=,pgid=,ppid=,uid=,stat=,command='], { encoding: 'utf8' });
                const groups = new Set(owned.children.map((child) => String(child.pid)));
                fs.writeFileSync(
                    path.join(run, 'owned-group-before-cleanup.txt'),
                    ps.stdout.split('\n').filter((line) => groups.has(line.trim().split(/\s+/)[1])).join('\n')
                );
                const userExtensionsPrefix = path.join(os.homedir(), '.vscode', 'extensions') + path.sep;
                const leaked = fs
                    .readFileSync(path.join(run, 'owned-group-before-cleanup.txt'), 'utf8')
                    .split('\n')
                    .filter((line) => line.includes(userExtensionsPrefix));
                if (leaked.length) {
                    fs.writeFileSync(path.join(run, 'isolation-failure.txt'), leaked.join('\n'));
                    runReport.status = 'failed';
                    runReport.failure ??= 'Isolation failure: an owned process ran from the user VS Code extensions directory.';
                    batchReport.failure ??= runReport.failure;
                    suiteFailed = true;
                }
                try {
                    await owned.stop();
                } catch (error) {
                    // The process-group signal can fail with EPERM after the leader exits (as in the browser runner).
                    // Preserve it, then stop each remaining member of our own group individually and verify.
                    const groupError = String(error);
                    const memberCleanup = await stopOwnedGroupMembers(groups);
                    fs.writeFileSync(
                        path.join(run, 'owned-cleanup-failure.txt'),
                        JSON.stringify({ groupSignalError: groupError, memberCleanup }, null, 2)
                    );
                    if (memberCleanup.remaining.length || memberCleanup.errors.length) {
                        cleanupFailure = `${groupError}; remaining owned group members: ${JSON.stringify(memberCleanup)}`;
                        runReport.status = 'failed';
                        runReport.failure ??= cleanupFailure;
                        batchReport.failure ??= cleanupFailure;
                        suiteFailed = true;
                    }
                } finally {
                    owned.dispose();
                }
                const terminate = simctl('terminate', config.simulator.udid, config.simulator.bundleId);
                fs.writeFileSync(
                    path.join(run, 'post-run-cleanup.json'),
                    JSON.stringify(
                        {
                            appTerminate: { status: terminate.status, err: terminate.stderr.slice(-400) },
                            appBundle: hashAppBundle(stage),
                            uiPortFree: await freePort(config.ports.ui).then(() => true, (e) => String(e)),
                        },
                        null,
                        2
                    )
                );
                try {
                    R.bundlePrivateProfileLogs(run, profile);
                    extractCdacEvidence(run);
                } catch (error) {
                    runReport.status = 'failed';
                    runReport.failure ??= String(error);
                    suiteFailed = true;
                }
                const observed = R.summarizeObservedRuns(runReports, all, mode, repetitions);
                fs.writeFileSync(
                    path.join(batch, 'measurement-summary.json'),
                    JSON.stringify(
                        {
                            batchId: identity.batchId,
                            runIds: runReports.map((r) => r.runId),
                            ...observed,
                            workload,
                            mode,
                            cohort,
                            definitions: {
                                launch: 'harness startDebugging(type maui) -> first managed coreclr_mobile stopped; includes MAUI preLaunchTask incremental build, mlaunch install/launch and app startup',
                                observationPollingMs: 25,
                                preCaptureQuiescenceMs: 300,
                                inspectionTimeoutMs: 30000,
                                explicitStackScopesVariablesRequests: 0,
                                uiDrivenExtendedInspection: !!config.extendedInspection,
                                implicitEvaluationPolicy: 'Default csharp.debug settings (JMC and implicit evaluation on).',
                                percentilePolicy: 'No p95 claim for this small bounded sample.',
                            },
                        },
                        null,
                        2
                    )
                );
                runReport.finishedAt = new Date().toISOString();
                const attachFile = path.join(run, 'managed-attach-result.json');
                if (fs.existsSync(attachFile)) {
                    const attach = JSON.parse(fs.readFileSync(attachFile, 'utf8'));
                    runReport.observations = {
                        userBreakObserved: attach.userBreakObserved,
                        actualStoppedSourceLines: attach.messages
                            .filter((e) => e.message.type === 'event' && e.message.event === 'stopped')
                            .map((e) => e.message.body.line ?? -1),
                        managedSessionTypes: attach.sessions.map((s) => s.type).join(','),
                        explicitInspectionRequests: attach.explicitInspectionRequests,
                    };
                }
                runReport.links = [{ label: 'Batch README', path: R.relativeReportLink(run, path.join(batch, 'README.md')) }, ...R.evidenceLinks(run)];
                batchReport.status = suiteFailed ? 'failed' : observed.completedRuns === repetitions ? 'passed' : 'incomplete';
                batchReport.completedRuns = observed.completedRuns;
                batchReport.completedSteps = observed.completedSteps;
                batchReport.finishedAt = batchReport.status === 'incomplete' ? null : runReport.finishedAt;
                batchReport.links = [
                    ...runReports.map((r) => ({
                        label: `${r.label}: ${r.runId} (${r.status})`,
                        path: R.relativeReportLink(batch, path.join(artifactRoot, r.directory, 'README.md')),
                    })),
                    ...R.evidenceLinks(batch),
                ];
                R.writeReport(artifactRoot, runReport, runSamples);
                R.writeReport(artifactRoot, batchReport, observed.samples);
                if (cleanupFailure) throw Error(cleanupFailure);
            }
        }
    } catch (error) {
        batchReport.status = 'failed';
        batchReport.failure ??= String(error);
        batchReport.finishedAt = new Date().toISOString();
        try {
            R.writeReport(artifactRoot, batchReport, all);
        } catch (reportError) {
            console.error('Batch report generation failed; original error:', error, reportError);
        }
        throw error;
    }
    console.log(`iOS debugger workload evidence: ${batch}`);
    return batch;
}
module.exports = { loadIosConfig, stageIos, cohortInventory, runIos };
