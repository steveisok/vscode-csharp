/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export type ReportMode = 'steps' | 'entry' | 'capability';
export type ReportStatus = 'incomplete' | 'passed' | 'failed';
export interface ReportIdentity {
    kind: 'batch' | 'run';
    batchId: string;
    runId?: string;
    directory: string;
    generatedAt: string;
}
export interface ReportMetadata extends ReportIdentity {
    workload: string;
    scenario: string;
    mode: ReportMode;
    status: ReportStatus;
    startedAt: string | null;
    finishedAt: string | null;
    firstCapturedAt?: string | null;
    backfilledAt?: string;
    updatedAt?: string;
    label?: string;
    failure?: string;
    cohort: Record<string, string | Record<string, string>>;
    versions: Record<string, string>;
    requestedRuns?: number;
    completedRuns?: number;
    completedSteps?: number;
    links: { label: string; path: string }[];
    distributions?: ReturnType<typeof timingDistributions>;
    observations?: Record<string, string | number | boolean | number[]>;
}
export interface TimingSample {
    commandToStopMs: number;
    commandToAutomaticInspectionMs: number;
    commandToVisibleRefreshObservationMs: number;
}

const metrics = {
    commandToStopMs: 'Command to managed stop',
    commandToAutomaticInspectionMs: 'Command to automatic inspection',
    commandToVisibleRefreshObservationMs: 'Command to visible refresh observation',
    postStopInspectionMs: 'Post-stop automatic inspection (paired intervals)',
};

export const measurementNotes = `Startup, readiness, anchor/history navigation and preparation are untimed. Havit uses the opt-in fully interpreted/no-R2R URL-helper profile and primitive url/hashIndex, not richer async filtering or parity with normal team benchmark profiles. Small measures Main 15->16->17; Havit measures only UrlHelper 18->19->20 after untimed preparation 15->16->18.

Automatic Call Stack/scopes/baseline Locals only; no duplicate explicit managed inspection, Watch or expansion. Default implicit evaluation remains enabled: absence of FuncEvalResultConsumed completion markers does not prove no implicit evaluation occurred.

Inspection has a 30s failure bound, 300ms quiescence and 25ms observation polling. Visible refresh includes polling, quiescence and capture overhead, not pure paint. Executed statement CPU is included; overlapping protocol requests must not be summed as wall time, and transport reads include waiting. Small bounded samples have no p95 claim.

The earlier async grid-filtering 63->65 stall remains unresolved/deferred. The old proxy reply-loss interleaving is not proven. In the last accepted matched baseline, scoped logs had no known close-error matches, but graceful native listener exit was not established (the owned wrapper stops it); generic VS Code console errors remain in raw logs. Future outcomes must be read from each run's own evidence. These are baseline capabilities, not general breakpoint/object-expansion/evaluation reliability claims.`;

function safeToken(value: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(value)) {
        throw new Error(`Invalid report identity token: ${value}`);
    }
    return value;
}

export function relativeReportLink(fromDirectory: string, target: string): string {
    return path.relative(fromDirectory, target).split(path.sep).map(encodeURIComponent).join('/');
}

function register(root: string, identity: ReportIdentity): void {
    const registry = path.join(root, 'report-registry');
    fs.mkdirSync(registry, { recursive: true });
    const id = identity.runId ?? identity.batchId;
    safeToken(id);
    fs.writeFileSync(path.join(registry, `${id}.json`), JSON.stringify(identity, null, 2) + '\n', { flag: 'wx' });
}

export function allocateReportDirectory(
    root: string,
    workload: string,
    mode: ReportMode,
    batch?: ReportIdentity,
    now = new Date(),
    uuid = randomUUID()
): ReportIdentity {
    const suffix = `${now.toISOString().replace(/[:.]/g, '-')}-${safeToken(uuid.replaceAll('-', '').slice(0, 12))}`;
    const id = `${safeToken(workload)}-${mode}-${batch ? 'run' : 'batch'}-${suffix}`;
    const parent = batch ? path.join(root, batch.directory) : root;
    const directory = path.join(parent, id);
    fs.mkdirSync(directory);
    const identity: ReportIdentity = {
        kind: batch ? 'run' : 'batch',
        batchId: batch?.batchId ?? id,
        ...(batch ? { runId: id } : {}),
        directory: path.relative(root, directory),
        generatedAt: now.toISOString(),
    };
    try {
        register(root, identity);
    } catch (error) {
        fs.rmdirSync(directory);
        throw error;
    }
    return identity;
}

export function registerLegacyReport(
    root: string,
    directory: string,
    workload: string,
    mode: ReportMode,
    batch?: ReportIdentity
): ReportIdentity {
    const relative = path.relative(root, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(directory).isDirectory()) {
        throw new Error('Legacy report must reference an existing in-scope archive.');
    }
    const id = `${safeToken(workload)}-${mode}-${batch ? 'run' : 'batch'}-backfill-${randomUUID()}`;
    const identity: ReportIdentity = {
        kind: batch ? 'run' : 'batch',
        batchId: batch?.batchId ?? id,
        ...(batch ? { runId: id } : {}),
        directory: relative,
        generatedAt: new Date().toISOString(),
    };
    register(root, identity);
    return identity;
}

export function timingDistributions(samples: TimingSample[]) {
    const values = samples.map((sample) => {
        for (const metric of Object.keys(metrics).slice(0, 3) as (keyof TimingSample)[]) {
            if (!Number.isFinite(sample[metric]) || sample[metric] < 0) {
                throw new Error(`Invalid observed timing: ${metric}`);
            }
        }
        if (sample.commandToAutomaticInspectionMs < sample.commandToStopMs) {
            throw new Error('Inspection completion cannot precede the managed stop.');
        }
        return { ...sample, postStopInspectionMs: sample.commandToAutomaticInspectionMs - sample.commandToStopMs };
    });
    return Object.fromEntries(
        Object.keys(metrics).map((metric) => {
            const sorted = values.map((value) => value[metric as keyof (typeof values)[number]]).sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            return [
                metric,
                {
                    n: sorted.length,
                    min: sorted[0] ?? null,
                    median: sorted.length
                        ? sorted.length % 2
                            ? sorted[mid]
                            : (sorted[mid - 1] + sorted[mid]) / 2
                        : null,
                    max: sorted[sorted.length - 1] ?? null,
                    p95: null,
                },
            ];
        })
    );
}

function timingTable(distributions: ReturnType<typeof timingDistributions>): string {
    return [
        '| Measurement (ms) | n | Minimum | Median | Maximum |',
        '|---|---:|---:|---:|---:|',
        ...Object.entries(distributions).map(([key, value]) => {
            if (value.n < 1 || value.min === null || value.median === null || value.max === null) {
                throw new Error('Cannot render empty timings as a measured result.');
            }
            return `| ${metrics[key as keyof typeof metrics]} | ${value.n} | ${value.min.toFixed(3)} | ${value.median.toFixed(3)} | ${value.max.toFixed(3)} |`;
        }),
    ].join('\n');
}

export function renderReport(metadata: ReportMetadata): string {
    const id = metadata.runId ?? metadata.batchId;
    const measured = metadata.status === 'passed' && metadata.mode === 'steps';
    const outcome = measured ? 'PASSED - measured steps' : `${metadata.status.toUpperCase()} - ${metadata.mode}`;
    if (measured && (!metadata.distributions || !Object.values(metadata.distributions).every((d) => d.n > 0))) {
        throw new Error('A passed measurement report requires observed samples.');
    }
    return `# ${metadata.workload}: ${metadata.label ?? metadata.kind}

**${outcome}.** ${metadata.scenario}

| Identity / outcome | Value |
|---|---|
| Batch ID | \`${metadata.batchId}\` |
| ${metadata.runId ? 'Run ID' : 'Report ID'} | \`${id}\` |
| Started (UTC) | ${metadata.startedAt ?? 'Not recorded; not inferred from backfill time'} |
| First captured event (UTC) | ${metadata.firstCapturedAt ?? 'Not separately recorded'} |
| Finished (UTC) | ${metadata.finishedAt ?? 'Not recorded'} |
| Report generated (UTC) | ${metadata.generatedAt} |
| Report updated (UTC) | ${metadata.updatedAt ?? metadata.generatedAt} |
| Backfill (UTC) | ${metadata.backfilledAt ?? 'No - live runner metadata'} |
| Completed runs / requested | ${metadata.completedRuns ?? 'Not applicable'} / ${metadata.requestedRuns ?? 'Not applicable'} |
| Completed step evidence | ${metadata.completedSteps ?? 'Not recorded'} |

${metadata.failure ? `## Failure\n\n\`\`\`text\n${metadata.failure}\n\`\`\`\n\n` : ''}${measured ? timingTable(metadata.distributions!) : 'No headline timing distribution: failed/incomplete runs are not accepted measurements, and entry/capability pilots are untimed.'}

${
    metadata.observations
        ? `## Captured outcome\n\n| Observation | Value |\n|---|---|\n${Object.entries(metadata.observations)
              .map(
                  ([key, value]) =>
                      `| ${key} | ${typeof value === 'string' ? value.replaceAll('|', '\\|').replace(/[\r\n]/g, ' ') : JSON.stringify(value)} |`
              )
              .join('\n')}\n`
        : ''
}

## Versions and cohort

| Component | Version / SHA-256 |
|---|---|
${Object.entries(metadata.versions)
    .map(([name, value]) => `| ${name} | ${value} |`)
    .join('\n')}
${Object.entries(metadata.cohort)
    .flatMap(([name, value]) =>
        typeof value === 'string'
            ? [`| ${name} | \`${value}\` |`]
            : Object.entries(value).map(([file, hash]) => `| ${name}/${file} | \`${hash}\` |`)
    )
    .join('\n')}

## Evidence

${metadata.links.map((link) => `- [${link.label}](${link.path})`).join('\n')}

## Definitions and limitations

${measurementNotes}
`;
}

export function evidenceLinks(directory: string): ReportMetadata['links'] {
    return fs
        .readdirSync(directory, { withFileTypes: true })
        .filter(
            (entry) =>
                entry.name !== 'report-metadata.json' &&
                entry.name !== 'README.md' &&
                (!entry.isDirectory() || ['user-data', 'proxy-logs'].includes(entry.name)) &&
                (entry.isDirectory() || /\.(json|png|log|txt)$/.test(entry.name))
        )
        .map((entry) => ({
            label: entry.name === 'user-data' ? 'VS Code and js-debug raw logs' : entry.name,
            path:
                entry.name === 'user-data'
                    ? 'user-data/logs/'
                    : entry.name === 'proxy-logs'
                      ? 'proxy-logs/'
                      : encodeURIComponent(entry.name),
        }));
}

export function hasMatchingCapability(
    root: string,
    workload: string,
    cohort: ReportMetadata['cohort'],
    host: string
): boolean {
    const registry = path.join(root, 'report-registry');
    if (!fs.existsSync(registry)) {
        return false;
    }
    const canonical = (value: ReportMetadata['cohort']) =>
        JSON.stringify(
            Object.keys(value)
                .sort()
                .map((key) => [
                    key,
                    typeof value[key] === 'string'
                        ? value[key]
                        : Object.entries(value[key]).sort(([a], [b]) => a.localeCompare(b)),
                ])
        );
    return fs.readdirSync(registry).some((file) => {
        const identity: ReportIdentity = JSON.parse(fs.readFileSync(path.join(registry, file), 'utf8'));
        if (!identity.runId) {
            return false;
        }
        const metadataFile = path.join(root, identity.directory, 'report-metadata.json');
        if (!fs.existsSync(metadataFile)) {
            return false;
        }
        const metadata: ReportMetadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
        return (
            metadata.workload === workload &&
            metadata.status === 'passed' &&
            metadata.mode === 'capability' &&
            metadata.versions.host === host &&
            canonical(metadata.cohort) === canonical(cohort)
        );
    });
}

export function writeReport(root: string, metadata: ReportMetadata, samples: TimingSample[], exclusive = false): void {
    metadata.updatedAt = new Date().toISOString();
    if (metadata.status === 'passed' && metadata.mode === 'steps') {
        metadata.distributions = timingDistributions(samples);
    } else {
        delete metadata.distributions;
    }
    const content = renderReport(metadata);
    const directory = path.join(root, metadata.directory);
    if (exclusive && ['README.md', 'report-metadata.json'].some((file) => fs.existsSync(path.join(directory, file)))) {
        throw new Error('Report sidecars already exist; do not overwrite them.');
    }
    fs.writeFileSync(
        path.join(directory, 'report-metadata.json'),
        JSON.stringify(metadata, null, 2) + '\n',
        exclusive ? { flag: 'wx' } : {}
    );
    fs.writeFileSync(path.join(directory, 'README.md'), content, exclusive ? { flag: 'wx' } : {});
    writeReportIndex(root);
}

export function writeReportIndex(root: string): void {
    const registry = path.join(root, 'report-registry');
    const rows = fs.existsSync(registry)
        ? fs
              .readdirSync(registry)
              .map((file) => JSON.parse(fs.readFileSync(path.join(registry, file), 'utf8')) as ReportIdentity)
              .sort((a, b) => a.batchId.localeCompare(b.batchId) || a.directory.localeCompare(b.directory))
              .map((identity) => {
                  const metadataFile = path.join(root, identity.directory, 'report-metadata.json');
                  if (!fs.existsSync(metadataFile)) {
                      return `| \`${identity.runId ?? identity.batchId}\` | incomplete - allocation only | [Archive](${relativeReportLink(root, path.join(root, identity.directory))}/) |`;
                  }
                  const metadata: ReportMetadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
                  return `| \`${metadata.runId ?? metadata.batchId}\` | ${metadata.status} / ${metadata.mode} / ${metadata.label ?? metadata.workload} | [README](${relativeReportLink(root, path.join(root, metadata.directory, 'README.md'))}) |`;
              })
        : [];
    const known = [
        ['Latest matched Small/Havit comparison', 'pending-table-lock-matched-baselines.README.md'],
        [
            'Untimed new-proxy capability pilot (passed; not a timing baseline)',
            'havit-capability-automatic-2026-10-12T18-13-41-444Z/measurement-summary.json',
        ],
        [
            'Earlier Havit startup/readiness failure (zero valid timing samples)',
            'havit-steps-automatic-2026-10-12T17-57-25-790Z/untimed-readiness-response-boundary.json',
        ],
        ['Deferred grid-filtering regression (unresolved)', 'havit-grid-filtering-regression/unresolved-status.json'],
    ]
        .filter(([, file]) => fs.existsSync(path.join(root, file)))
        .map(([label, file]) => `- [${label}](${file})`);
    const content = `# Browser debugger runs

Reports and raw evidence stay together. Batch IDs and globally unique run IDs resolve through [report-registry](report-registry/). ${fs.existsSync(path.join(root, 'pending-table-lock-matched-baselines.report.json')) ? 'The two current measured batches are backfilled with sidecar identities; their original JSON, logs, screenshots and cohort captures are unchanged. Other historical archives are not all migrated.' : 'This is a separate artifact area; earlier archives are not moved or automatically migrated here.'}

${known.join('\n')}

| Batch / run ID | Status / mode / label | Report |
|---|---|---|
${rows.join('\n')}

## Operator commands (from extension worktree root)

\`\`\`bash
${
    fs.existsSync(path.join(root, 'openPrototype.sh'))
        ? `
bash out/wasm-prototype/openPrototype.sh small
bash out/wasm-prototype/openPrototype.sh havit
node out/wasm-prototype/runStepCapabilities.js small 3 steps
node out/wasm-prototype/runStepCapabilities.js havit 3 steps
node out/wasm-prototype/runStepCapabilities.js havit 1 capability`
        : `
npm run prototype -- open small --config <machine.local.json>
npm run prototype -- open havit --config <machine.local.json>
npm run prototype -- run small 3 steps --config <machine.local.json>
npm run prototype -- run havit 3 steps --config <machine.local.json>
npm run prototype -- run havit 1 capability --config <machine.local.json>`
}
\`\`\`

Runner CLI: \`<small|havit> <1..5> <steps|entry|capability>\`; entry/capability require exactly one run. Workload handoff gates still apply. Each invocation exclusively creates \`<workload>-<mode>-batch-<UTC timestamp>-<12 UUID hex>\`, with individual \`<workload>-<mode>-run-<UTC timestamp>-<12 UUID hex>\` directories inside. Local run-1/run-2 labels are only labels, never global identities. On collision creation fails rather than overwriting evidence.

For interactive use, the maintained Node \`open\` command owns the app server and Concord listener; select the staged launch configuration and F5. The older local operator instead uses its existing "Start local Concord DAP" task. Havit starts without a fragment; after attach/first render click the desktop "Filtering from headers" link, navigate Back then Forward, prepare 15->16->18 untimed, and F10 only 18->19->20. Do not step out of line 20 for this baseline. Global VS Code settings/extensions remain untouched.
`;
    const temporary = path.join(root, `.report-index-${randomUUID()}.tmp`);
    fs.writeFileSync(temporary, content, { flag: 'wx' });
    fs.renameSync(temporary, path.join(root, 'README.md'));
}

export function renderMatchedComparison(
    small: { metadata: ReportMetadata; samples: TimingSample[] },
    havit: { metadata: ReportMetadata; samples: TimingSample[] },
    readiness?: {
        pilot: string;
        pilotRequests: number;
        requestsPerRun: number[];
        maximumResponseMsPerRun: number[];
        failureBoundMs: number;
    }
): string {
    for (const report of [small, havit]) {
        if (report.metadata.status !== 'passed' || report.metadata.mode !== 'steps' || !report.samples.length) {
            throw new Error('Matched comparison requires two passed measured batches.');
        }
    }
    for (const key of [
        'concord',
        'browserDebugHost',
        'browserDebugProxy',
        'browserDebugHostRuntimeConfig',
        'dbi',
        'dac',
    ]) {
        if (!small.metadata.cohort[key] || small.metadata.cohort[key] !== havit.metadata.cohort[key]) {
            throw new Error(`Unmatched comparison cohort: ${key}`);
        }
    }
    const targetHashes = (report: typeof small) => Object.values(report.metadata.cohort.nativeWasmFiles ?? {}).sort();
    if (!targetHashes(small).length || JSON.stringify(targetHashes(small)) !== JSON.stringify(targetHashes(havit))) {
        throw new Error('Unmatched comparison target runtime.');
    }
    const left = timingDistributions(small.samples);
    const right = timingDistributions(havit.samples);
    return `# Matched Small / Havit debugger baseline

**Both passed: ${small.metadata.completedRuns} Small / ${havit.metadata.completedRuns} Havit sessions and ${small.samples.length} / ${havit.samples.length} measured F10 steps.** Same proxy/host/native cohort; Havit is the primitive synchronous URL helper, not the deferred async-filtering workload.

| Measurement (ms) | Small n | Small min / median / max | Havit n | Havit min / median / max |
|---|---:|---:|---:|---|
${Object.keys(metrics)
    .map((key) => {
        const a = left[key],
            b = right[key];
        const format = (value: typeof a) => [value.min, value.median, value.max].map((n) => n!.toFixed(3)).join(' / ');
        return `| ${metrics[key as keyof typeof metrics]} | ${a.n} | ${format(a)} | ${b.n} | ${format(b)} |`;
    })
    .join('\n')}

Havit's median command-to-stop excess is ${(right.commandToStopMs.median! - left.commandToStopMs.median!).toFixed(3)}ms. Most of the observed excess is before the stop; paired post-stop inspection medians are ${right.postStopInspectionMs.median!.toFixed(3)}ms Havit versus ${left.postStopInspectionMs.median!.toFixed(3)}ms Small. This is an interval comparison, not an identified root cause.

## Batches, individual runs and screenshots

${[small, havit]
    .map(
        ({ metadata }) =>
            `- [${metadata.workload} batch README](${metadata.directory}/README.md) - \`${metadata.batchId}\`\n${metadata.links
                .filter((link) => link.label.startsWith('Run '))
                .map(
                    (link) =>
                        `  - [${link.label}](${metadata.directory}/${link.path}) (README links to original screenshots, JSON and logs)`
                )
                .join('\n')}`
    )
    .join('\n')}

[Original comparison JSON](pending-table-lock-matched-baselines.json) | [Backfill sidecar IDs](pending-table-lock-matched-baselines.report.json) | [Raw archive hash preservation](reporting-backfill-preservation.json)

## Readiness, cohort and limitations

${readiness ? `The separate untimed pilot passed ${readiness.pilotRequests} correctly correlated readiness requests and normal URL-helper entry/steps. Havit measured-run readiness requests were ${readiness.requestsPerRun.join('/')} with maxima ${readiness.maximumResponseMsPerRun.join('/')}ms, below the unchanged ${readiness.failureBoundMs}ms per-response failure bound; none is a stepping latency sample. [Readiness pilot](${readiness.pilot}). Each Havit run links its exact readiness tuples.` : 'Readiness correlation counts are not supplied to this comparison; consult the per-run raw evidence. Readiness is untimed and is not a stepping latency sample.'}

${Object.entries(small.metadata.cohort)
    .filter(([key]) => !['appAssembly', 'appPdb', 'nativeWasmFiles'].includes(key))
    .map(([key, value]) => `- ${key}: \`${value}\``)
    .join('\n')}

Target WASM SHA-256: ${targetHashes(small)
        .map((hash) => `\`${hash}\``)
        .join(
            ', '
        )}. Batch/run reports contain the exact app DLL/PDB hashes and available version provenance; unrecorded historical versions/times are not invented.

${measurementNotes}

In the accepted six-run baseline, logs contained no FuncEvalResultConsumed completion markers; this is only a log observation, not proof of no implicit evaluation. All owned helpers were stopped. No debugger workload was rerun to generate these reports. Report generation/backfill timestamps are separate from original observations.
`;
}
