/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, expect, test } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { hostPlatform, sha256 } from '../../../tasks/debugger/prototype/prototypeConfig';
import { allocateReportDirectory, ReportMetadata, writeReport } from '../integrationTests/debuggerReports';

let fixture: string;
beforeEach(() => {
    fixture = fs.mkdtempSync(path.join(process.cwd(), 'out/prototype-measurement-gate-'));
});
afterEach(() => fs.rmSync(fixture, { recursive: true }));

function write(relative: string, value = 'fixture'): string {
    const file = path.join(fixture, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
    return file;
}
function gateFixture() {
    const host = hostPlatform('darwin', 'arm64');
    const stage = path.join(fixture, 'stage');
    const root = path.join(fixture, 'results');
    fs.mkdirSync(root);
    const handoff = write('stage/havit/handoff.json', JSON.stringify({ explicitRunnableHandoff: true }));
    const framework = 'stage/havit/wwwroot/_framework/';
    const components = [
        ['extensionBundle', 'stage/extension/dist/extension.js'],
        ['concord', 'producer/' + host.concordEngine],
        ['browserDebugHost', 'stage/extension/.vswebassemblybridge/Microsoft.Diagnostics.BrowserDebugHost.dll'],
        ['browserDebugProxy', 'stage/extension/.vswebassemblybridge/Microsoft.Diagnostics.BrowserDebugProxy.dll'],
        [
            'browserDebugHostRuntimeConfig',
            'stage/extension/.vswebassemblybridge/Microsoft.Diagnostics.BrowserDebugHost.runtimeconfig.json',
        ],
        ['dbi', framework + host.dbi],
        ['dac', framework + host.dac],
        ['appAssembly', framework + 'Havit.Blazor.Documentation.dll'],
        ['appPdb', framework + 'Havit.Blazor.Documentation.pdb'],
    ];
    const hashes = Object.fromEntries(components.map(([name, file]) => [name, sha256(write(file))]));
    const wasm = write(framework + 'dotnet.native.wasm');
    const manifestFile = write('manifest.json', JSON.stringify({ immutableFixture: true }));
    const cohort = {
        ...hashes,
        sourceManifest: sha256(manifestFile),
        nativeWasmFiles: { 'dotnet.native.wasm': sha256(wasm) },
    };
    const configFile = write('machine.local.json', JSON.stringify({ fixture: true }));
    const workload = {
        id: 'havit',
        workspace: 'havit',
        handoff: 'havit/handoff.json',
        assembly: 'Havit.Blazor.Documentation',
        url: 'http://127.0.0.1:8001/components/HxGrid',
        stops: [
            { sourceSuffix: 'UrlHelper.cs', line: 18, localNames: ['url'] },
            { sourceSuffix: 'UrlHelper.cs', line: 19, localNames: ['url'] },
        ],
        server: { command: process.execPath, args: [] },
    };
    write('stage/workloads/havit.json', JSON.stringify(workload));
    const options = {
        config: {
            extensionRoot: process.cwd(),
            artifactRoot: root,
            manifest: manifestFile,
            paths: { concordPublish: path.join(fixture, 'producer'), smallHandoff: handoff, havitHandoff: handoff },
        },
        host,
        manifest: {
            cohortId: 'fixture',
            versions: {},
            sources: [
                { id: 'native', origin: 'https://example.test/native', ref: 'refs/heads/test', commit: '1'.repeat(40) },
            ],
            workloads: { small: { handoffSha256: sha256(handoff) }, havit: { handoffSha256: sha256(handoff) } },
        },
        stage,
        selector: 'havit',
        repetitions: 3,
        mode: 'steps',
        configFile,
    };
    return { root, cohort, options, handoff };
}
function invoke(options: object) {
    const owned = path.resolve('out/tasks/debugger/prototype/ownedProcesses.js');
    const runner = path.resolve('tasks/debugger/prototype/runStepCapabilities.js');
    const code = `require(${JSON.stringify(owned)}).OwnedProcesses=class {constructor(){throw Error('MATCHING_CAPABILITY_GATE_ACCEPTED_BEFORE_HELPERS');}};require(${JSON.stringify(runner)}).runStepCapabilities(JSON.parse(process.argv[1])).catch(e=>{console.error(e.message);process.exitCode=1;});`;
    return spawnSync(process.execPath, ['-e', code, JSON.stringify(options)], { encoding: 'utf8' });
}
function capability(root: string, cohort: ReportMetadata['cohort']): ReportMetadata {
    const batch = allocateReportDirectory(root, 'havit', 'capability');
    const run = allocateReportDirectory(root, 'havit', 'capability', batch);
    return {
        ...run,
        workload: 'havit',
        scenario: 'url-helper',
        mode: 'capability',
        status: 'passed',
        startedAt: run.generatedAt,
        finishedAt: run.generatedAt,
        versions: { host: 'darwin-arm64' },
        cohort,
        links: [],
    };
}
test('real Havit three-run gate accepts a genuine matching capability without an owner acceptance boolean', () => {
    const f = gateFixture();
    writeReport(f.root, capability(f.root, f.cohort), []);
    expect(invoke(f.options).stderr).toContain('MATCHING_CAPABILITY_GATE_ACCEPTED_BEFORE_HELPERS');
    expect(JSON.parse(fs.readFileSync(f.handoff, 'utf8')).debuggerCapabilitiesVerified).toBeUndefined();
});
test('legacy owner boolean without a measured-host capability never authorizes helpers', () => {
    const f = gateFixture();
    fs.writeFileSync(f.handoff, JSON.stringify({ explicitRunnableHandoff: true, debuggerCapabilitiesVerified: true }));
    const result = invoke(f.options);
    expect(result.stderr).toContain('Run havit 1 capability first');
    expect(result.stderr).not.toContain('MATCHING_CAPABILITY_GATE_ACCEPTED_BEFORE_HELPERS');
    expect(fs.readdirSync(f.root)).toHaveLength(0);
});
test.each(['failed', 'wrong-mode', 'other-workload', 'other-host', 'changed-hash', 'stale-manifest'])(
    '%s capability rejects the actual runner before any owned helper or batch allocation',
    (kind) => {
        const f = gateFixture();
        const report = capability(f.root, f.cohort);
        if (kind === 'failed') {
            report.status = 'failed';
        }
        if (kind === 'wrong-mode') {
            report.mode = 'entry';
        }
        if (kind === 'other-workload') {
            report.workload = 'small';
        }
        if (kind === 'other-host') {
            report.versions.host = 'linux-arm64';
        }
        if (kind === 'changed-hash') {
            report.cohort = { ...f.cohort, concord: 'changed' };
        }
        if (kind === 'stale-manifest') {
            report.cohort = { ...f.cohort, sourceManifest: 'stale-manifest' };
        }
        writeReport(f.root, report, []);
        const before = fs.readdirSync(f.root).sort();
        const result = invoke(f.options);
        expect(result.stderr).toContain('Run havit 1 capability first');
        expect(result.stderr).not.toContain('MATCHING_CAPABILITY_GATE_ACCEPTED_BEFORE_HELPERS');
        expect(fs.readdirSync(f.root).sort()).toEqual(before);
    }
);
