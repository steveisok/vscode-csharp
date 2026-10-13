/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import {
    allocateReportDirectory,
    bundlePrivateProfileLogs,
    evidenceLinks,
    hasMatchingCapability,
    registerLegacyReport,
    relativeReportLink,
    renderMatchedComparison,
    ReportMetadata,
    timingDistributions,
    summarizeObservedRuns,
    writeReport,
} from '../integrationTests/debuggerReports';

const clock = new Date('2026-10-12T18:17:10.909Z');
const uuid1 = '11111111-1111-4111-8111-111111111111';
const uuid2 = '22222222-2222-4222-8222-222222222222';
const samples = [
    { commandToStopMs: 100, commandToAutomaticInspectionMs: 400, commandToVisibleRefreshObservationMs: 800 },
    { commandToStopMs: 500, commandToAutomaticInspectionMs: 900, commandToVisibleRefreshObservationMs: 1300 },
];
const cohort = {
    concord: 'concord-sha',
    browserDebugHost: 'host-sha',
    browserDebugProxy: 'proxy-sha',
    browserDebugHostRuntimeConfig: 'config-sha',
    dbi: 'dbi-sha',
    dac: 'dac-sha',
    nativeWasmFiles: { 'native.wasm': 'target-sha' },
};
let root: string;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(process.cwd(), 'out/debugger-reports-test-'));
});
afterEach(() => {
    fs.rmSync(root, { recursive: true });
});

function metadata(identity = allocateReportDirectory(root, 'small', 'steps', undefined, clock, uuid1)): ReportMetadata {
    return {
        ...identity,
        workload: 'small',
        scenario: 'existing-main-user-break',
        status: 'passed',
        mode: 'steps',
        startedAt: clock.toISOString(),
        finishedAt: clock.toISOString(),
        cohort,
        versions: { sdk: 'fixture-sdk' },
        completedRuns: 1,
        requestedRuns: 1,
        completedSteps: samples.length,
        links: [],
    };
}

describe('Debugger report identities and evidence', () => {
    test.each(['passed', 'failed'] as const)(
        '%s results bundle private logs with portable relative report links',
        (status) => {
            const m = metadata();
            m.mode = 'capability';
            m.status = status;
            if (status === 'failed') {
                m.failure = 'Original capability failure';
            }
            const directory = path.join(root, m.directory);
            const profile = path.join(root, 'private-profile');
            fs.mkdirSync(path.join(profile, 'logs/window1'), { recursive: true });
            fs.mkdirSync(path.join(profile, 'Cache'));
            fs.writeFileSync(path.join(profile, 'logs/window1/bridge.log'), 'Original proxy and debugger diagnostics');
            fs.writeFileSync(path.join(profile, 'Cache/large-cache'), 'not result evidence');
            const retained = bundlePrivateProfileLogs(directory, profile);
            expect(retained.status).toBe('copied');
            expect(retained.files).toHaveLength(1);
            expect(fs.readFileSync(path.join(directory, 'vscode-logs/window1/bridge.log'), 'utf8')).toContain(
                'diagnostics'
            );
            expect(fs.existsSync(path.join(directory, 'vscode-logs/Cache'))).toBe(false);
            fs.rmSync(profile, { recursive: true });
            m.links = evidenceLinks(directory);
            writeReport(root, m, []);
            expect(m.links).toContainEqual({ label: 'VS Code and js-debug raw logs', path: 'vscode-logs/' });
            const text = fs.readFileSync(path.join(directory, 'README.md'), 'utf8');
            expect(text).toContain('(vscode-logs/)');
            expect(text).not.toContain('file:///');
            for (const link of m.links) {
                expect(fs.existsSync(path.resolve(directory, decodeURIComponent(link.path)))).toBe(true);
            }
        }
    );
    test('missing diagnostics are explicit, and copy failure throws without overwriting retained logs', () => {
        const directory = path.join(root, 'missing-result');
        fs.mkdirSync(directory);
        expect(bundlePrivateProfileLogs(directory, undefined)).toMatchObject({
            status: 'absent',
            reason: 'No private profile was allocated.',
        });
        const profile = path.join(root, 'profile');
        fs.mkdirSync(path.join(profile, 'logs'), { recursive: true });
        fs.writeFileSync(path.join(profile, 'logs/raw.log'), 'raw');
        const blocked = path.join(root, 'blocked-result');
        fs.mkdirSync(path.join(blocked, 'vscode-logs'), { recursive: true });
        fs.writeFileSync(path.join(blocked, 'vscode-logs/original.log'), 'preserved');
        expect(() => bundlePrivateProfileLogs(blocked, profile)).toThrow('do not overwrite');
        expect(JSON.parse(fs.readFileSync(path.join(blocked, 'log-retention.json'), 'utf8')).status).toBe('failed');
        expect(fs.readFileSync(path.join(blocked, 'vscode-logs/original.log'), 'utf8')).toBe('preserved');
    });
    test('same-clock batches and individual runs have distinct IDs and exclusive directories', () => {
        const first = allocateReportDirectory(root, 'small', 'steps', undefined, clock, uuid1);
        const second = allocateReportDirectory(root, 'small', 'steps', undefined, clock, uuid2);
        const run = allocateReportDirectory(root, 'small', 'steps', first, clock, uuid1);
        const anotherRun = allocateReportDirectory(root, 'small', 'steps', first, clock, uuid2);
        expect(new Set([first.batchId, second.batchId, run.runId, anotherRun.runId]).size).toBe(4);
        expect(run.batchId).toBe(first.batchId);
        expect(run.directory).toBe(path.join(first.directory, run.runId!));
        const pointer = JSON.parse(fs.readFileSync(path.join(root, 'report-registry', `${run.runId}.json`), 'utf8'));
        expect(pointer).toEqual(run);
        expect(fs.statSync(path.join(root, pointer.directory)).isDirectory()).toBe(true);
    });

    test('an exact collision throws and cannot overwrite existing evidence', () => {
        const first = allocateReportDirectory(root, 'small', 'steps', undefined, clock, uuid1);
        const raw = path.join(root, first.directory, 'raw.json');
        fs.writeFileSync(raw, 'original');
        expect(() => allocateReportDirectory(root, 'small', 'steps', undefined, clock, uuid1)).toThrow();
        expect(fs.readFileSync(raw, 'utf8')).toBe('original');
        expect(() => allocateReportDirectory(root, '../outside', 'steps')).toThrow('Invalid report identity');
    });

    test('legacy sidecars keep original directories and bytes with distinct backfill identities', () => {
        const directory = path.join(root, 'legacy');
        fs.mkdirSync(directory);
        const raw = path.join(directory, 'cohort-provenance.json');
        fs.writeFileSync(raw, '{"original":"bytes"}');
        const identity = registerLegacyReport(root, directory, 'small', 'steps');
        const m = metadata(identity);
        m.startedAt = null;
        m.finishedAt = null;
        m.backfilledAt = m.generatedAt;
        m.links = evidenceLinks(directory);
        writeReport(root, m, samples, true);
        expect(fs.readFileSync(raw, 'utf8')).toBe('{"original":"bytes"}');
        expect(identity.batchId).toContain('backfill-');
        expect(m.directory).toBe('legacy');
        const text = fs.readFileSync(path.join(directory, 'README.md'), 'utf8');
        expect(text).toContain('Not recorded; not inferred from backfill time');
        expect(text).toContain(m.generatedAt);
        const originalReport = fs.readFileSync(path.join(directory, 'report-metadata.json'));
        expect(() => writeReport(root, m, samples, true)).toThrow();
        expect(fs.readFileSync(path.join(directory, 'report-metadata.json'))).toEqual(originalReport);
    });

    test('an existing README blocks exclusive backfill before any metadata is written', () => {
        const m = metadata();
        const directory = path.join(root, m.directory);
        fs.writeFileSync(path.join(directory, 'README.md'), 'Existing user report');
        expect(() => writeReport(root, m, samples, true)).toThrow('do not overwrite');
        expect(fs.readFileSync(path.join(directory, 'README.md'), 'utf8')).toBe('Existing user report');
        expect(fs.existsSync(path.join(directory, 'report-metadata.json'))).toBe(false);
    });

    test('README, machine metadata, registry and relative artifact links agree', () => {
        const batch = allocateReportDirectory(root, 'havit', 'steps');
        const run = allocateReportDirectory(root, 'havit', 'steps', batch);
        const directory = path.join(root, run.directory);
        fs.writeFileSync(path.join(directory, 'stop 2-ui.png'), 'fixture');
        fs.writeFileSync(path.join(directory, 'automatic-step-results.json'), '{"fixture":true}');
        const m = { ...metadata(run), workload: 'havit', label: 'Run 1', links: evidenceLinks(directory) };
        writeReport(root, m, samples);
        const json = JSON.parse(fs.readFileSync(path.join(directory, 'report-metadata.json'), 'utf8'));
        expect(json.runId).toBe(run.runId);
        expect(json.batchId).toBe(batch.batchId);
        const readme = fs.readFileSync(path.join(directory, 'README.md'), 'utf8');
        expect(readme).toContain(run.runId!);
        expect(readme).toContain(batch.batchId);
        expect(readme).toContain('stop%202-ui.png');
        for (const link of json.links) {
            expect(fs.existsSync(path.resolve(directory, decodeURIComponent(link.path)))).toBe(true);
        }
        expect(relativeReportLink(directory, path.join(root, batch.directory, 'README.md'))).toBe('../README.md');
        const index = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
        expect(index).toContain(`${run.directory}/README.md`);
        expect(index).toContain('incomplete - allocation only');
        expect(index).toContain('havit 1 capability');
    });
});

describe('Observed report math and honest outcomes', () => {
    test.each(['cleanup', 'log-retention', 'test'])(
        '%s-failed third run excludes samples after final status while retaining observations',
        (failure) => {
            const reports = [
                { runId: 'one', status: 'passed' as const },
                { runId: 'two', status: 'passed' as const },
                { runId: 'three', status: 'failed' as const, failure: `Original ${failure} error` },
            ];
            const observed = reports.flatMap((report) => samples.map((sample) => ({ ...sample, runId: report.runId })));
            const result = summarizeObservedRuns(reports, observed, 'steps', 3);
            expect(result.status).toBe('failed');
            expect(result.attemptedRuns).toBe(3);
            expect(result.completedRuns).toBe(2);
            expect(result.observedSteps).toBe(6);
            expect(result.completedSteps).toBe(4);
            expect(result.excludedSteps).toBe(2);
            expect(result.observedSamples).toEqual(observed);
            expect(result.samples.map((sample) => sample.runId)).toEqual(['one', 'one', 'two', 'two']);
            expect(result.excludedSamples.map((sample) => sample.runId)).toEqual(['three', 'three']);
            expect(result.acceptedDistributions.commandToStopMs?.n).toBe(4);
            expect(result.distributions).toEqual({});
            expect(result.excludedRunIds).toEqual(['three']);
            expect(result.distributionStatus).toBe('partial accepted runs only');
            expect(reports[2].failure).toBe(`Original ${failure} error`);
        }
    );
    test('all-success three-session batch accepts six steps only after finalized passed statuses', () => {
        const reports = ['one', 'two', 'three'].map((runId) => ({ runId, status: 'passed' as const }));
        const observed = reports.flatMap((report) => samples.map((sample) => ({ ...sample, runId: report.runId })));
        const result = summarizeObservedRuns(reports, observed, 'steps', 3);
        expect(result.status).toBe('passed');
        expect(result.completedRuns).toBe(3);
        expect(result.completedSteps).toBe(6);
        expect(result.excludedSamples).toEqual([]);
        expect(result.distributions.commandToStopMs?.n).toBe(6);
        expect(result.distributionStatus).toBe('complete');
    });
    test('an explicitly labeled passed replacement can be aggregated without mutating failed status or losing observations', () => {
        const reports = [
            { runId: 'failed-original', status: 'failed' as const },
            { runId: 'replacement', status: 'passed' as const },
        ];
        const observed = reports.flatMap((report) => samples.map((sample) => ({ ...sample, runId: report.runId })));
        const result = summarizeObservedRuns(reports, observed, 'steps', 1);
        expect(result.status).toBe('failed');
        expect(result.acceptedRunIds).toEqual(['replacement']);
        expect(result.excludedSteps).toBe(2);
        expect(reports[0].status).toBe('failed');
    });
    test('untimed or incomplete summaries do not manufacture headline timing distributions', () => {
        const observed = samples.map((sample) => ({ ...sample, runId: 'one' }));
        const passed = [{ runId: 'one', status: 'passed' as const }];
        expect(summarizeObservedRuns(passed, observed, 'capability', 1).distributions).toEqual({});
        const pending = summarizeObservedRuns(passed, observed, 'steps', 3);
        expect(pending.status).toBe('incomplete');
        expect(pending.distributions).toEqual({});
        expect(pending.acceptedDistributions.commandToStopMs?.n).toBe(2);
    });
    test('measurement gate requires an actual passed capability for the exact workload, host and hashes', () => {
        const batch = allocateReportDirectory(root, 'small', 'capability');
        const run = allocateReportDirectory(root, 'small', 'capability', batch);
        const m = metadata(run);
        m.mode = 'capability';
        m.versions.host = 'darwin-arm64';
        expect(hasMatchingCapability(root, 'small', cohort, 'darwin-arm64')).toBe(false);
        writeReport(root, m, []);
        expect(hasMatchingCapability(root, 'small', cohort, 'darwin-arm64')).toBe(true);
        expect(hasMatchingCapability(root, 'havit', cohort, 'darwin-arm64')).toBe(false);
        expect(hasMatchingCapability(root, 'small', cohort, 'win32-x64')).toBe(false);
        expect(
            hasMatchingCapability(root, 'small', { ...cohort, browserDebugProxy: 'new-proxy' }, 'darwin-arm64')
        ).toBe(false);
        m.status = 'failed';
        writeReport(root, m, []);
        expect(hasMatchingCapability(root, 'small', cohort, 'darwin-arm64')).toBe(false);
    });
    test('calculates min/median/max and paired post-stop intervals, not difference of medians', () => {
        expect(timingDistributions(samples).commandToStopMs).toEqual({
            n: 2,
            min: 100,
            median: 300,
            max: 500,
            p95: null,
        });
        expect(timingDistributions(samples).postStopInspectionMs.median).toBe(350);
        const crossed = [
            { ...samples[0], commandToAutomaticInspectionMs: 1000 },
            { ...samples[1], commandToAutomaticInspectionMs: 600 },
            { commandToStopMs: 900, commandToAutomaticInspectionMs: 1100, commandToVisibleRefreshObservationMs: 1500 },
        ];
        const distributions = timingDistributions(crossed);
        expect(distributions.postStopInspectionMs.median).toBe(200);
        expect(distributions.commandToAutomaticInspectionMs.median! - distributions.commandToStopMs.median!).toBe(500);
        expect(timingDistributions(samples.slice(0, 1)).commandToStopMs.median).toBe(100);
    });

    test.each([NaN, -1, Infinity])('rejects invalid timing %s rather than substituting zero', (value) => {
        expect(() => timingDistributions([{ ...samples[0], commandToStopMs: value }])).toThrow(
            'Invalid observed timing'
        );
    });

    test('rejects reversed completion and missing passed samples', () => {
        expect(() => timingDistributions([{ ...samples[0], commandToAutomaticInspectionMs: 50 }])).toThrow();
        const m = metadata();
        expect(() => writeReport(root, m, [])).toThrow('observed samples');
        expect(fs.existsSync(path.join(root, m.directory, 'README.md'))).toBe(false);
    });

    test.each(['failed', 'incomplete'] as const)(
        '%s reports preserve errors without headline timing fallbacks',
        (status) => {
            const m = metadata();
            m.status = status;
            m.failure = 'Original lost readiness reply: seq240/internal3215';
            writeReport(root, m, samples);
            const text = fs.readFileSync(path.join(root, m.directory, 'README.md'), 'utf8');
            expect(text).toContain(status.toUpperCase());
            expect(text).toContain(m.failure);
            expect(text).toContain('No headline timing distribution');
            expect(text).not.toContain('| Minimum |');
            expect(text).not.toContain('PASSED');
            expect(
                JSON.parse(fs.readFileSync(path.join(root, m.directory, 'report-metadata.json'), 'utf8')).distributions
            ).toBeUndefined();
        }
    );

    test('a later failure removes an earlier distribution instead of leaving success-shaped metrics', () => {
        const m = metadata();
        writeReport(root, m, samples);
        m.status = 'failed';
        m.failure = 'Original failure is retained';
        writeReport(root, m, samples);
        const sidecar = JSON.parse(fs.readFileSync(path.join(root, m.directory, 'report-metadata.json'), 'utf8'));
        expect(sidecar.distributions).toBeUndefined();
        expect(sidecar.failure).toBe('Original failure is retained');
        expect(fs.readFileSync(path.join(root, m.directory, 'README.md'), 'utf8')).not.toContain('| Minimum |');
    });

    test.each(['entry', 'capability'] as const)('passed %s reports never manufacture timings', (mode) => {
        const m = metadata();
        m.mode = mode;
        writeReport(root, m, []);
        const text = fs.readFileSync(path.join(root, m.directory, 'README.md'), 'utf8');
        expect(text).toContain(`PASSED - ${mode}`);
        expect(text).toContain('pilots are untimed');
        expect(text).not.toContain('| Minimum |');
    });

    test('matched comparison uses paired medians, links both batches and rejects mixed or failed cohorts', () => {
        const small = metadata();
        const havit = { ...small, workload: 'havit', batchId: 'havit-batch', directory: 'havit-dir' };
        const left = { metadata: small, samples };
        const right = {
            metadata: havit,
            samples: samples.map((s) => ({
                commandToStopMs: s.commandToStopMs + 722,
                commandToAutomaticInspectionMs: s.commandToAutomaticInspectionMs + 708,
                commandToVisibleRefreshObservationMs: s.commandToVisibleRefreshObservationMs + 708,
            })),
        };
        const text = renderMatchedComparison(left, right);
        expect(text).toContain('722.000ms');
        expect(text).toContain('336.000ms Havit versus 350.000ms Small');
        expect(text).toContain('not an identified root cause');
        expect(text).toContain('havit-dir/README.md');
        expect(text).toContain('does not prove no implicit evaluation');
        expect(() => renderMatchedComparison(left, { ...right, metadata: { ...havit, status: 'failed' } })).toThrow();
        expect(() =>
            renderMatchedComparison(left, {
                ...right,
                metadata: {
                    ...havit,
                    cohort: { ...cohort, browserDebugProxy: 'other-proxy' },
                },
            })
        ).toThrow('Unmatched comparison cohort');
        expect(() =>
            renderMatchedComparison(left, {
                ...right,
                metadata: {
                    ...havit,
                    cohort: { ...cohort, nativeWasmFiles: { 'native.wasm': 'different-target' } },
                },
            })
        ).toThrow('target runtime');
    });
});
