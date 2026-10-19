/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const root = path.resolve(__dirname, '../../..');
const compiled = path.join(root, 'out/tasks/debugger/prototype');
if (!fs.existsSync(path.join(compiled, 'prototypeConfig.js'))) {
    throw Error('Compile maintained tools first: npx tsc -p tsconfig.json (extension bundle: npm run packageDev).');
}
const { hostPlatform, loadMachineConfig, preflight, validateProfilePath, verifiedConcordExecutable } = require(
    path.join(compiled, 'prototypeConfig.js')
);
const { OwnedProcesses } = require(path.join(compiled, 'ownedProcesses.js'));
const { stageExtension } = require('./stageExtension.js');
const { runStepCapabilities } = require('./runStepCapabilities.js');

function parseArguments(args) {
    const position = args.indexOf('--config');
    if (position < 0 || !args[position + 1])
        throw Error('An explicit --config <ignored machine-local.json> is required.');
    const filename = path.resolve(args[position + 1]);
    const rest = [...args.slice(0, position), ...args.slice(position + 2)];
    const [command, selector, repetitions, mode] = rest;
    if (!['preflight', 'setup', 'open', 'run'].includes(command)) throw Error('Use preflight, setup, open, or run.');
    if (command === 'preflight' || command === 'setup') {
        if (rest.length !== 1) throw Error('preflight/setup accept only --config.');
    } else if (selector !== 'small' && selector !== 'havit') throw Error('Select small or havit.');
    if (command === 'open' && rest.length !== 2) throw Error('open accepts <small|havit> and --config.');
    if (
        command === 'run' &&
        (rest.length !== 4 ||
            !Number.isInteger(Number(repetitions)) ||
            Number(repetitions) < 1 ||
            Number(repetitions) > 5 ||
            !['steps', 'entry', 'capability'].includes(mode) ||
            (mode !== 'steps' && repetitions !== '1'))
    ) {
        throw Error('run accepts <small|havit> <1..5> <steps|entry|capability>; untimed pilots require 1.');
    }
    return { command, selector, repetitions: Number(repetitions), mode, filename };
}
function createPrivateProfile(config, host) {
    fs.mkdirSync(config.profileRoot, { recursive: true });
    const directory = path.join(config.profileRoot, `r-${randomUUID().replaceAll('-', '').slice(0, 12)}`);
    validateProfilePath(directory, host);
    fs.mkdirSync(directory);
    fs.mkdirSync(path.join(directory, 'User'));
    fs.writeFileSync(
        path.join(directory, 'User/settings.json'),
        JSON.stringify({
            'telemetry.telemetryLevel': 'off',
            'dotnetAcquisitionExtension.existingDotnetPath': [
                { extensionId: 'ms-dotnettools.csharp', path: config.executables.dotnet },
            ],
        })
    );
    return directory;
}
function childEnvironment(config, run) {
    const env = {
        ...process.env,
        DOTNET_ROOT: path.dirname(config.executables.dotnet),
        VSCODE_CSHARP_WASMDBG_DOTNET: config.executables.dotnet,
        VSCODE_CSHARP_WASMDBG_ARTIFACT_DIR: path.join(run, 'proxy-logs'),
        VSCODE_CSHARP_WASMDBG_CONCORD: config.paths.concordPublish,
    };
    delete env.WASMDBG_ARTIFACT_DIR;
    delete env.DOTNET_WASM_DBI_CONTINUE_TRACE;
    // Diagnostic runs enable only the proxy's performance summary; general proxy logging stays off.
    // Without the opt-in, the inherited environment is passed through unchanged, as before.
    if (config.diagnosticLogging) {
        delete env.WASMDBG_LOGGING;
        env.WASMDBG_PERFORMANCE_LOGGING = '1';
    }
    return env;
}
async function main() {
    const args = parseArguments(process.argv.slice(2));
    const host = hostPlatform(process.platform, process.arch);
    const config = loadMachineConfig(args.filename, host);
    const manifest = preflight(config, host);
    console.log(
        `Host: ${host.key}; ${host.validation}. Cohort: ${manifest.cohortId}. Preflight is not runtime acceptance.`
    );
    if (args.command === 'preflight') return;
    if (args.command === 'setup') {
        const stage = stageExtension(config, host, manifest);
        console.log(`Complete isolated stage: ${stage}. No helper was launched.`);
        return;
    }
    // Stage a new private generation instead of mutating a previous stage or historic evidence.
    const stage = stageExtension(config, host, manifest);
    if (args.command === 'run') {
        return runStepCapabilities({
            config,
            host,
            manifest,
            stage,
            selector: args.selector,
            repetitions: args.repetitions,
            mode: args.mode,
            createPrivateProfile,
            childEnvironment,
            configFile: args.filename,
        });
    }
    const owned = new OwnedProcesses();
    let originalFailure;
    try {
        const profile = createPrivateProfile(config, host);
        const workspace = path.join(stage, args.selector === 'small' ? 'sample' : 'havit');
        const workload = JSON.parse(fs.readFileSync(path.join(stage, 'workloads', `${args.selector}.json`)));
        const env = childEnvironment(config, stage);
        const { freePort, waitReady } = require('./runStepCapabilities.js');
        for (const port of [config.ports[args.selector], config.ports.dap, config.ports.ui]) await freePort(port);
        const server = owned.spawn(
            workload.server.command,
            workload.server.args.map((arg) => arg.replaceAll('${workspace}', workspace)),
            { cwd: stage, env, stdio: 'inherit' }
        );
        await waitReady(
            async () => {
                const response = await fetch(workload.url, { signal: AbortSignal.timeout(1000) });
                if (!response.ok) throw Error(`HTTP ${response.status}`);
            },
            server,
            'App server'
        );
        const dap = owned.spawn(
            verifiedConcordExecutable(config, host, manifest),
            [`--server=${config.ports.dap}`, '--consoleLogging'],
            { cwd: stage, env, stdio: ['ignore', 'pipe', 'pipe'] }
        );
        let dapOutput = '';
        dap.stdout.on('data', (chunk) => {
            dapOutput += chunk.toString();
            process.stdout.write(chunk);
        });
        dap.stderr.on('data', (chunk) => {
            dapOutput += chunk.toString();
            process.stderr.write(chunk);
        });
        await waitReady(
            async () => {
                if (!dapOutput.includes('Waiting for communication'))
                    throw Error('Concord has not announced readiness.');
            },
            dap,
            'Concord listener'
        );
        const code = owned.spawn(
            config.executables.vscode,
            [
                workspace,
                '--new-window',
                '--disable-workspace-trust',
                '--skip-welcome',
                '--skip-release-notes',
                '--disable-extension',
                'github.copilot-chat',
                '--user-data-dir',
                profile,
                '--extensions-dir',
                path.join(stage, 'extensions'),
                '--extensionDevelopmentPath',
                path.join(stage, 'extension'),
            ],
            { cwd: stage, env, stdio: 'inherit' }
        );
        console.log(
            'Owned app server and Concord listener started. Select the staged debug configuration and F5; close this private Code window when done.'
        );
        await new Promise((resolve, reject) => {
            code.once('error', reject);
            code.once('close', (exit, signal) =>
                exit === 0 ? resolve() : reject(Error(`Owned Code exited ${exit}/${signal}`))
            );
        });
    } catch (error) {
        originalFailure = error;
        throw error;
    } finally {
        try {
            await owned.stop();
        } catch (error) {
            console.error('Owned cleanup failed; original launcher error (if any):', originalFailure, error);
            if (!originalFailure) throw error;
        } finally {
            owned.dispose();
        }
    }
}
module.exports = { parseArguments, createPrivateProfile, childEnvironment };
if (require.main === module)
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
