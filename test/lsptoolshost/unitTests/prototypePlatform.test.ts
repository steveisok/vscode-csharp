/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess, execFileSync } from 'child_process';
import {
    discoverExecutable,
    hostPlatform,
    knownInstallLocations,
    loadMachineConfig,
    preflight,
    resolveConfigPath,
    sha256,
    validateProfilePath,
    verifyAssets,
} from '../../../tasks/debugger/prototype/prototypeConfig';
import { ownedCleanupCommand, ownedSpawnOptions, stopOwned } from '../../../tasks/debugger/prototype/ownedProcesses';

let fixture: string;
beforeEach(() => {
    fixture = fs.mkdtempSync(path.join(process.cwd(), 'out/prototype-platform-test-'));
});
afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(fixture, { recursive: true });
});
function write(relative: string, content = 'fixture') {
    const file = path.join(fixture, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    fs.chmodSync(file, 0o700);
    return file;
}
function assets(role: string, filenames: string[]) {
    return {
        cohortId: 'fixture-cohort',
        files: filenames.map((name) => {
            const file = write(`${role}/${name}`);
            return { path: name, size: fs.statSync(file).size, sha256: sha256(file) };
        }),
    };
}
function configFixture() {
    const host = hostPlatform('win32', 'amd64');
    const executable = write('tools with spaces/real executable.exe');
    const native = assets('native', [host.dbi, host.dac]);
    const concord = assets('concord', [host.dap, host.concordEngine]);
    const proxy = assets('proxy', [
        'Microsoft.Diagnostics.BrowserDebugHost.dll',
        'Microsoft.Diagnostics.BrowserDebugProxy.dll',
        'Microsoft.Diagnostics.BrowserDebugHost.runtimeconfig.json',
    ]);
    const runtime = assets('runtime-pack', ['native.wasm']);
    const handoffFile = write('handoff.json', JSON.stringify({ explicitRunnableHandoff: true }));
    const sourceFile = write('source/Program.cs');
    const app = (role: string, assembly: string) => ({
        ...assets(role, [`_framework/${assembly}.dll`, `_framework/${assembly}.pdb`, '_framework/native.wasm']),
        assembly,
        appDll: `_framework/${assembly}.dll`,
        appPdb: `_framework/${assembly}.pdb`,
        nativeWasm: '_framework/native.wasm',
        handoffSha256: sha256(handoffFile),
        sourceFiles: [{ path: 'Program.cs', sha256: sha256(sourceFile) }],
    });
    const manifest = {
        schemaVersion: 1,
        cohortId: 'fixture-cohort',
        targetArchitecture: 'wasm32',
        versions: { sdk: 'fixture' },
        hosts: {
            [host.key]: { native, concord, proxy, endToEndValidated: false, features: { wasmdbgArtifactDir: true } },
        },
        runtimePack: runtime,
        workloads: { small: app('small', 'Wasm.Browser.Sample'), havit: app('havit', 'Havit.Blazor.Documentation') },
    };
    const manifestFile = write('cohort.local.json', JSON.stringify(manifest));
    fs.mkdirSync(path.join(fixture, 'extensions'));
    write('dist/extension.js');
    const machine = {
        schemaVersion: 1,
        extensionRoot: fixture,
        artifactRoot: '${extensionRoot}/out/results with spaces',
        profileRoot: '${extensionRoot}/p',
        manifest: manifestFile,
        allowUnvalidatedHost: true,
        browserType: 'edge',
        paths: {
            runtimeRoot: '${extensionRoot}/source',
            havitRoot: '${runtimeRoot}',
            runtimePack: '${extensionRoot}/runtime-pack',
            nativeAssets: '${extensionRoot}/native',
            concordPublish: '${extensionRoot}/concord',
            proxyPublish: '${extensionRoot}/proxy',
            smallWebRoot: '${extensionRoot}/small',
            havitWebRoot: '${extensionRoot}/havit',
            smallHandoff: handoffFile,
            havitHandoff: handoffFile,
            havitServerModule: write('bench.mjs'),
            extensionDependencies: path.join(fixture, 'extensions'),
        },
        executables: { vscode: executable, browser: executable, dotnet: executable, dotnetServe: executable },
        ports: { small: 8000, havit: 8001, dap: 4711, ui: 9335 },
        sourceMaps: { small: { '${runtimeRoot}': '${runtimeRoot}' }, havit: { '${havitRoot}': '${havitRoot}' } },
    };
    const configFile = write('machine.local.json', JSON.stringify(machine));
    return { host, manifest, manifestFile, machine, configFile };
}
describe('Prototype host and local configuration preflight', () => {
    test.each([
        ['win32', 'x86_64', 'vsdbg-ui.exe', 'mscordbi_universal.dll'],
        ['linux', 'amd64', 'vsdbg-ui', 'libmscordbi_universal.so'],
        ['darwin', 'arm64', 'vsdbg-ui', 'libmscordbi_universal.dylib'],
    ])('selects native host filenames independently of wasm32 on %s/%s', (os, arch, dap, dbi) => {
        const host = hostPlatform(os, arch);
        expect(host.dap).toBe(dap);
        expect(host.dbi).toBe(dbi);
        expect(host.arch).toBe(arch === 'arm64' ? 'arm64' : 'x64');
        expect(host.validation).toContain(os === 'darwin' ? 'prior cohort' : 'unvalidated');
    });
    test.each([
        ['freebsd', 'x64'],
        ['linux', 'ia32'],
        ['win32', 'wasm32'],
    ])('fails unsupported %s/%s before staging', (os, arch) => {
        expect(() => hostPlatform(os, arch)).toThrow('Unsupported prototype host');
    });
    test('explicit paths with spaces win discovery without shell quoting or fallback', () => {
        const file = write('folder with spaces/executable');
        expect(discoverExecutable(file, ['different'], fs.existsSync)).toBe(file);
        expect(() => discoverExecutable(file + '-missing', [file])).toThrow('will not override');
        expect(resolveConfigPath('${root}/folder with spaces/executable', { root: fixture }, fixture)).toBe(file);
        expect(() => resolveConfigPath('${unknown}/file', {}, fixture)).toThrow('Unresolved');
        expect(() => discoverExecutable(undefined, [])).toThrow('no download');
    });
    test('known Windows/Linux discovery paths are host-specific and injectable', () => {
        expect(
            knownInstallLocations('vscode', hostPlatform('win32', 'x64'), '', {
                LOCALAPPDATA: 'C:\\Local AppData',
                ProgramFiles: 'C:\\Program Files',
            })[0]
        ).toBe('C:\\Local AppData\\Programs\\Microsoft VS Code\\Code.exe');
        expect(knownInstallLocations('browser', hostPlatform('linux', 'x64'), '', {})).toContain(
            '/opt/microsoft/msedge/msedge'
        );
    });
    test('short profiles apply Unix limits only, without global aliases or Windows symlinks', () => {
        expect(() => validateProfilePath('/tmp/p/r-0123456789ab', hostPlatform('darwin', 'arm64'))).not.toThrow();
        expect(() => validateProfilePath('/' + 'x'.repeat(100), hostPlatform('darwin', 'arm64'))).toThrow('socket');
        expect(() => validateProfilePath('/' + 'x'.repeat(105), hostPlatform('linux', 'x64'))).toThrow('socket');
        expect(() => validateProfilePath('C:\\' + 'x'.repeat(150), hostPlatform('win32', 'x64'))).not.toThrow();
    });
    test('loads resolved spaced machine config, verifies all assets and marks experimental host explicitly', () => {
        const f = configFixture();
        const config = loadMachineConfig(f.configFile, f.host);
        expect(config.artifactRoot).toBe(path.join(fixture, 'out/results with spaces'));
        expect(config.executables.browser).toBe(f.machine.executables.browser);
        expect(config.paths.havitRoot).toBe(config.paths.runtimeRoot);
        expect(preflight(config, f.host).cohortId).toBe('fixture-cohort');
        expect(() => preflight({ ...config, allowUnvalidatedHost: false }, f.host)).toThrow('unvalidated');
        expect(() => preflight(config, hostPlatform('linux', 'arm64'))).toThrow('No native');
    });
    test('invalid fields, ports and output paths fail closed', () => {
        const f = configFixture();
        for (const change of [
            { ports: { ...f.machine.ports, ui: 4711 } },
            { paths: { ...f.machine.paths, nativeAssets: 7 } },
            { artifactRoot: fixture },
            { allowUnvalidatedHost: 'yes' },
        ]) {
            fs.writeFileSync(f.configFile, JSON.stringify({ ...f.machine, ...change }));
            expect(() => loadMachineConfig(f.configFile, f.host)).toThrow();
        }
    });
    test('old proxy feature, mismatched runtime or source/handoff changes cannot pass', () => {
        const f = configFixture();
        const config = loadMachineConfig(f.configFile, f.host);
        f.manifest.hosts[f.host.key].features.wasmdbgArtifactDir = false;
        fs.writeFileSync(f.manifestFile, JSON.stringify(f.manifest));
        expect(() => preflight(config, f.host)).toThrow('NEW complete publish');
        f.manifest.hosts[f.host.key].features.wasmdbgArtifactDir = true;
        fs.writeFileSync(f.manifestFile, JSON.stringify(f.manifest));
        write('source/Program.cs', 'changed source');
        expect(() => preflight(config, f.host)).toThrow('source/PDB checksum');
    });
    test('changed target pack, held handoff and source version pairs fail explicitly', () => {
        const f = configFixture();
        const config = loadMachineConfig(f.configFile, f.host);
        write('runtime-pack/native.wasm', 'a different complete target');
        f.manifest.runtimePack.files[0] = {
            path: 'native.wasm',
            size: fs.statSync(path.join(fixture, 'runtime-pack/native.wasm')).size,
            sha256: sha256(path.join(fixture, 'runtime-pack/native.wasm')),
        };
        fs.writeFileSync(f.manifestFile, JSON.stringify(f.manifest));
        expect(() => preflight(config, f.host)).toThrow('target WASM does not match');
        write('runtime-pack/native.wasm');
        f.manifest.runtimePack.files[0] = { ...f.manifest.workloads.small.files[2], path: 'native.wasm' };
        write(
            'handoff.json',
            JSON.stringify({ explicitRunnableHandoff: true, nextPilotHeld: true, pilotHoldReason: 'owner hold' })
        );
        f.manifest.workloads.small.handoffSha256 = sha256(path.join(fixture, 'handoff.json'));
        fs.writeFileSync(f.manifestFile, JSON.stringify(f.manifest));
        expect(() => preflight(config, f.host)).toThrow('owner handoff holds');
    });
    test('stage uses physical copies, configured ports and URL-derived scalar expectations without launching', () => {
        const f = configFixture();
        for (const asset of [
            'src',
            'node_modules',
            'l10n',
            'images',
            'snippets',
            'themes',
            'RuntimeLicenses',
            '.roslyn',
            '.roslynDevKit',
            '.xamlTools',
            '.testDiscovery',
        ]) {
            write(`${asset}/fixture.txt`);
        }
        write(
            'package.json',
            JSON.stringify({ name: 'fixture', version: '1', runtimeDependencies: [{ stock: true }] })
        );
        const config = loadMachineConfig(f.configFile, f.host);
        const manifest = preflight(config, f.host);
        const moduleFile = path.resolve('tasks/debugger/prototype/stageExtension.js');
        // Run only the filesystem stage function with fixture bytes, never the launcher or native tools.
        const stage = execFileSync(
            process.execPath,
            [
                '-e',
                `const x=require(${JSON.stringify(moduleFile)});console.log(x.stageExtension(JSON.parse(process.argv[1]),JSON.parse(process.argv[2]),JSON.parse(process.argv[3])))`,
                JSON.stringify(config),
                JSON.stringify(f.host),
                JSON.stringify(manifest),
            ],
            { encoding: 'utf8' }
        ).trim();
        expect(stage.startsWith(config.artifactRoot + path.sep)).toBe(true);
        expect(fs.lstatSync(path.join(stage, 'extension/dist')).isSymbolicLink()).toBe(false);
        expect(fs.readFileSync(path.join(stage, 'extension/dist/extension.js'), 'utf8')).toBe('fixture');
        expect(
            JSON.parse(fs.readFileSync(path.join(stage, 'extension/package.json'), 'utf8')).runtimeDependencies
        ).toEqual([]);
        const workload = JSON.parse(fs.readFileSync(path.join(stage, 'workloads/havit.json'), 'utf8'));
        expect(workload.server.args[1]).toBe(config.paths.havitServerModule);
        expect(workload.stops[3].localValues.hashIndex).toBe(String((workload.url + '#header-filtering').indexOf('#')));
        const launch = JSON.parse(fs.readFileSync(path.join(stage, 'havit/.vscode/launch.json'), 'utf8'))
            .configurations[0];
        expect(launch.dotNetConfig.debugServer).toBe(config.ports.dap);
        expect(launch.browserConfig.userDataDir.startsWith(stage)).toBe(true);
        expect(fs.readFileSync(path.join(stage, 'havit/Havit.Blazor.Documentation.csproj'), 'utf8')).toContain(
            '<UseCoreCLR>true'
        );
        expect(fs.readFileSync(path.join(fixture, 'small/_framework/Wasm.Browser.Sample.dll'), 'utf8')).toBe('fixture');
    });
    test('common CLI parses spaced config arguments and fresh log environment without any helper launch', () => {
        const entry = path.resolve('tasks/debugger/prototype/prototype.js');
        const code = `const cli=require(${JSON.stringify(entry)});const config={executables:{dotnet:process.execPath}};console.log(JSON.stringify({parsed:cli.parseArguments(['run','havit','1','capability','--config','folder with spaces/local.json']),env:cli.childEnvironment(config,process.argv[1])}));`;
        const result = JSON.parse(execFileSync(process.execPath, ['-e', code, fixture], { encoding: 'utf8' }));
        expect(result.parsed.selector).toBe('havit');
        expect(result.parsed.filename).toContain('folder with spaces');
        expect(result.env.VSCODE_CSHARP_WASMDBG_ARTIFACT_DIR).toBe(path.join(fixture, 'proxy-logs'));
        expect(result.env.WASMDBG_ARTIFACT_DIR).toBeUndefined();
        expect(fs.existsSync(path.join(fixture, 'proxy-logs'))).toBe(false);
        expect(() =>
            execFileSync(
                process.execPath,
                [
                    '-e',
                    `require(${JSON.stringify(entry)}).parseArguments(['run','havit','3','capability','--config','x'])`,
                ],
                { stdio: 'pipe' }
            )
        ).toThrow();
    });
    test('asset cohort/hash/traversal/stale overlays fail rather than overwrite', () => {
        const list = assets('assets', ['valid.dll']);
        expect(() => verifyAssets(path.join(fixture, 'assets'), list, 'wrong', 'fixture')).toThrow('cohortId');
        expect(() =>
            verifyAssets(
                path.join(fixture, 'assets'),
                { ...list, files: [{ ...list.files[0], path: '../valid.dll' }] },
                list.cohortId,
                'fixture'
            )
        ).toThrow('unsafe');
        write('assets/stale.dll');
        expect(() => verifyAssets(path.join(fixture, 'assets'), list, list.cohortId, 'fixture')).toThrow('undeclared');
        fs.unlinkSync(path.join(fixture, 'assets/stale.dll'));
        write('assets/valid.dll', 'changed');
        expect(() => verifyAssets(path.join(fixture, 'assets'), list, list.cohortId, 'fixture')).toThrow('mismatch');
    });
});
describe('Owned native process cleanup selection (no process launched)', () => {
    test('Windows selects an exact PID tree and never shell/name matching', () => {
        expect(ownedCleanupCommand('win32', 123, true)).toEqual({
            command: 'taskkill',
            args: ['/PID', '123', '/T', '/F'],
        });
        expect(ownedSpawnOptions('win32')).toEqual({ detached: false, windowsHide: true, shell: false });
    });
    test('Unix targets only a newly detached owned process group', () => {
        expect(ownedCleanupCommand('linux', 123, false)).toEqual({ group: -123, signal: 'SIGTERM' });
        expect(ownedSpawnOptions('linux').detached).toBe(true);
        expect(() => ownedCleanupCommand('linux', -1, true)).toThrow('positive PID');
        expect(() => ownedCleanupCommand('freebsd', 123, false)).toThrow('Unsupported');
    });
    test('already signaled child cleanup does not await a close event that already happened', async () => {
        const kill = jest.spyOn(process, 'kill').mockReturnValue(true);
        const child = { pid: 123, exitCode: null, signalCode: 'SIGTERM' } as ChildProcess;
        await stopOwned(child, 'linux');
        expect(kill).toHaveBeenCalledWith(-123, 'SIGTERM');
        expect(kill).toHaveBeenCalledWith(-123, 'SIGKILL');
    });
});
