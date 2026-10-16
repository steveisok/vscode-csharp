/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DebuggerStopExpectation, DebuggerWorkload } from './debuggerWorkload';
import { callerInspectionSequence, ExtendedInspectionContext, launchAndBreakTimings } from './extendedInspection';

export interface TimedDebuggerRequest {
    command: string;
    sequence: number;
    arguments?: Record<string, unknown>;
    startedAt: number;
    finishedAt?: number;
    success?: boolean;
}
type Message = { session: string; message: Record<string, unknown>; at?: number };
type Frame = { id: number; name: string; line: number; column: number; source?: { path?: string } };
type Variable = { name: string; value: string; type?: string; variablesReference: number };

export async function measureAutomaticDebuggerSteps(
    session: vscode.DebugSession,
    workload: DebuggerWorkload,
    prototype: string,
    run: string,
    messages: Message[],
    requests: TimedDebuggerRequest[],
    stopTimes: number[],
    pending: Map<number, TimedDebuggerRequest>,
    context?: ExtendedInspectionContext
) {
    const observed: object[] = [];
    const steps: object[] = [];
    const commandStarts: number[] = [];
    let extendedActions: Record<string, unknown> | undefined;
    const measurementEnabled = process.env.WASM_PROTOTYPE_MEASUREMENT_ENABLED !== '0';
    const extendedEnabled = process.env.WASM_PROTOTYPE_EXTENDED_ACTIONS === '1';
    async function capture(label: string, stop?: DebuggerStopExpectation) {
        if (!process.env.WASM_PROTOTYPE_UI_PORT || !process.env.WASM_PROTOTYPE_NODE) {
            throw new Error('Owned UI inspection port and Node executable required.');
        }
        await promisify(execFile)(
            process.env.WASM_PROTOTYPE_NODE,
            [
                path.join(prototype, 'captureUi.js'),
                process.env.WASM_PROTOTYPE_UI_PORT,
                path.join(run, label),
                ...(stop ? [JSON.stringify(stop)] : []),
            ],
            { timeout: 12000 }
        );
        return JSON.parse(fs.readFileSync(path.join(run, `${label}.json`), 'utf8')) as {
            renderedUiObservedAtEpochMs: number;
            workbench: unknown;
        };
    }
    async function inspect(stopIndex: number, expected: DebuggerStopExpectation) {
        const stop = messages.filter(({ message }) => message.type === 'event' && message.event === 'stopped')[
            stopIndex
        ];
        const start = messages.indexOf(stop);
        const deadline = Date.now() + 30000;
        let quietSince: number | undefined;
        while (Date.now() < deadline) {
            const responses = messages.slice(start).filter(({ message }) => message.type === 'response');
            const response = (command: string, predicate: (args: Record<string, unknown>) => boolean = () => true) =>
                responses.find(
                    ({ message }) =>
                        message.command === command &&
                        message.success &&
                        predicate(requests.find((r) => r.sequence === message.request_seq)?.arguments ?? {})
                )?.message;
            const stack = response('stackTrace')?.body as { stackFrames: Frame[] } | undefined;
            const frame = stack?.stackFrames?.[0];
            const scopes =
                frame &&
                (response('scopes', (args) => args.frameId === frame.id)?.body as
                    | {
                          scopes: { name: string; variablesReference: number; expensive: boolean }[];
                      }
                    | undefined);
            const scope = scopes?.scopes.find((scope) => /locals/i.test(scope.name) && !scope.expensive);
            const variables =
                scope &&
                (response('variables', (args) => args.variablesReference === scope.variablesReference)?.body as
                    | {
                          variables: Variable[];
                      }
                    | undefined);
            const busy = [...pending.values()].some((r) =>
                ['threads', 'stackTrace', 'scopes', 'variables'].includes(r.command)
            );
            if (frame && scope && variables && !busy) {
                if (!frame.source?.path?.endsWith(expected.sourceSuffix) || frame.line !== expected.line) {
                    throw new Error(`Unexpected source stop: ${JSON.stringify(frame)}.`);
                }
                for (const name of expected.localNames) {
                    const variable = variables.variables.find((v) => v.name === name || v.name.startsWith(`${name} `));
                    if (!variable) {
                        throw new Error(`Baseline local ${name} was not refreshed.`);
                    }
                    if (expected.localValues?.[name] !== undefined && variable.value !== expected.localValues[name]) {
                        throw new Error(`Unexpected baseline value for ${name}: ${variable.value}.`);
                    }
                }
                quietSince ??= Date.now();
                if (Date.now() - quietSince >= 300) {
                    const completedAt = Math.max(
                        ...requests
                            .filter(
                                (r) =>
                                    r.startedAt >= stopTimes[stopIndex] &&
                                    ['stackTrace', 'scopes', 'variables'].includes(r.command)
                            )
                            .map((r) => r.finishedAt ?? 0)
                    );
                    const ui = await capture(`stop-${stopIndex}-ui`, expected);
                    return {
                        stop: stop.message.body,
                        frame,
                        scopes: scopes?.scopes,
                        variables: variables.variables,
                        completedAt,
                        ui,
                    };
                }
            } else {
                quietSince = undefined;
            }
            const failed = responses.find(
                ({ message }) =>
                    !message.success && ['stackTrace', 'scopes', 'variables'].includes(String(message.command))
            );
            if (failed) {
                throw new Error(`Automatic UI inspection failed: ${JSON.stringify(failed.message)}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(
            'Automatic Call Stack/Locals did not complete within the shared 30s bound, including 300ms quiescence; no explicit inspection fallback is permitted.'
        );
    }
    async function closeFinalPause(kind: 'stepOver' | 'continue') {
        // Diagnostic-only, unscored: resuming the final pause makes the proxy log that epoch's completion totals.
        const command = kind === 'stepOver' ? 'next' : 'continue';
        const stopsBefore = stopTimes.length;
        const messagesBefore = messages.length;
        const start = performance.now();
        await vscode.commands.executeCommand(
            kind === 'stepOver' ? 'workbench.action.debug.stepOver' : 'workbench.action.debug.continue',
            session.id
        );
        let response: Record<string, unknown> | undefined;
        let stopped: Message | undefined;
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const recent = messages.slice(messagesBefore);
            response = recent.find(
                ({ message }) => message.type === 'response' && message.command === command
            )?.message;
            if (response && !response.success) {
                throw new Error(`Closing ${command} failed: ${JSON.stringify(response)}`);
            }
            stopped = recent.find(({ message }) => message.type === 'event' && message.event === 'stopped');
            if (kind === 'stepOver' ? stopped : response) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (kind === 'stepOver' ? !stopped : !response) {
            throw new Error(`Closing ${kind} did not complete within 15 s.`);
        }
        // Let VS Code's automatic refresh settle so teardown does not interrupt in-flight requests.
        let quietSince: number | undefined;
        const settle = Date.now() + 30000;
        while (Date.now() < settle) {
            const busy = [...pending.values()].some((r) =>
                ['threads', 'stackTrace', 'scopes', 'variables'].includes(r.command)
            );
            quietSince = busy ? undefined : (quietSince ?? Date.now());
            if (quietSince !== undefined && Date.now() - quietSince >= 300) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return {
            kind,
            unscored: true,
            purpose:
                'Close the final pause epoch so the proxy logs pause-completed totals and [Perf]; variant Continue for Gap B differential.',
            commandToResponseMs:
                (requests.find((r) => r.startedAt >= start && r.command === command)?.finishedAt ?? NaN) - start,
            commandToStopMs: stopTimes.length > stopsBefore ? stopTimes[stopsBefore] - start : undefined,
            stop: stopped?.message.body,
            laterStops: messages
                .slice(messagesBefore)
                .filter(({ message }) => message.type === 'event' && message.event === 'stopped')
                .map(({ message }) => message.body),
            dap: requests
                .filter((r) => r.startedAt >= start)
                .map((r) => ({
                    command: r.command,
                    sequence: r.sequence,
                    arguments: r.arguments,
                    startedAtMs: r.startedAt - start,
                    finishedAtMs: r.finishedAt === undefined ? undefined : r.finishedAt - start,
                    success: r.success,
                })),
        };
    }
    try {
        observed.push(await inspect(0, workload.stops[0]));
        for (let index = 1; index < workload.stops.length; index++) {
            const start = performance.now();
            const epoch = Date.now();
            commandStarts[index] = start;
            await vscode.commands.executeCommand('workbench.action.debug.stepOver', session.id);
            const deadline = Date.now() + 15000;
            while (stopTimes.length <= index && Date.now() < deadline) {
                const failed = messages.find(
                    ({ message }) => message.type === 'response' && message.command === 'next' && !message.success
                );
                if (failed) {
                    throw new Error(`Normal Step Over failed: ${JSON.stringify(failed.message)}`);
                }
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            if (stopTimes.length <= index) {
                throw new Error('Accepted Step Over produced no managed next stop.');
            }
            const body = messages.filter(({ message }) => message.type === 'event' && message.event === 'stopped')[
                index
            ].message.body;
            if (!body || typeof body !== 'object' || !('reason' in body) || body.reason !== 'step') {
                throw new Error(`Next stop is not step-complete: ${JSON.stringify(body)}`);
            }
            const refresh = await inspect(index, workload.stops[index]);
            observed.push(refresh);
            if (index > (workload.preparationTransitions ?? 0)) {
                steps.push({
                    from: workload.stops[index - 1],
                    to: workload.stops[index],
                    requestStartedAt: start,
                    requestStartedAtEpochMs: epoch,
                    commandToStopMs: measurementEnabled ? stopTimes[index] - start : undefined,
                    commandToAutomaticInspectionMs: measurementEnabled ? refresh.completedAt - start : undefined,
                    commandToVisibleRefreshObservationMs: measurementEnabled
                        ? refresh.ui.renderedUiObservedAtEpochMs - epoch
                        : undefined,
                    measurementEnabled,
                    inspectionTimeoutMs: 30000,
                    inspectionQuiescenceMs: 300,
                    UIObservationIncludesPollingQuiescenceAndCapture: true,
                    baselineLocalsOnly: true,
                    expandedObjects: false,
                    explicitManagedEvaluationRequested: false,
                    automaticUiImplicitEvaluationExcluded: false,
                });
            }
        }
        if (extendedEnabled) {
            if (!context) {
                throw new Error('Extended inspection requires launch timing context.');
            }
            // Runs only after the final stop's existing automatic inspection, so F10 samples are unperturbed.
            const breakTimings = launchAndBreakTimings(workload, run, messages, requests, stopTimes, context);
            const topFrameLocals = (
                observed as { completedAt: number; ui: { renderedUiObservedAtEpochMs: number } }[]
            ).map((o, index) => ({
                stopIndex: index,
                line: workload.stops[index].line,
                boundary: index === 0 ? 'managed stopped event' : 'Step Over command',
                stoppedToAutomaticLocalsMs: o.completedAt - stopTimes[index],
                commandToAutomaticLocalsMs: index === 0 ? undefined : o.completedAt - commandStarts[index],
                stoppedToVisibleLocalsMs: o.ui.renderedUiObservedAtEpochMs - context.epochOffsetMs - stopTimes[index],
                commandToVisibleLocalsMs:
                    index === 0
                        ? undefined
                        : o.ui.renderedUiObservedAtEpochMs - context.epochOffsetMs - commandStarts[index],
            }));
            extendedActions = {
                userDirectedDeparture:
                    'User-authorized departure from measurement.md: UI-driven caller-frame selection and object expansion after the final stop.',
                ...breakTimings,
                expandTopFrameLocals: {
                    label: 'automatic top-frame Locals population; no expandable top-frame variable exists',
                    duplicatesStepInspectionField: true,
                    perStop: topFrameLocals,
                },
            };
            extendedActions.callerInspection = await callerInspectionSequence(
                workload,
                prototype,
                run,
                messages,
                requests,
                context
            );
            const closing = process.env.WASM_PROTOTYPE_CLOSING_ACTION;
            if (closing === 'stepOver' || closing === 'continue') {
                extendedActions.closingAction = await closeFinalPause(closing);
            }
        }
        return { steps, observed, automaticUiOnly: !extendedEnabled, extendedActions };
    } catch (error) {
        await capture('capability-blocker-ui');
        throw error;
    } finally {
        fs.writeFileSync(
            path.join(run, 'automatic-step-results.json'),
            JSON.stringify(
                {
                    batchId: process.env.WASM_PROTOTYPE_BATCH_ID,
                    runId: process.env.WASM_PROTOTYPE_RUN_ID,
                    workload,
                    steps,
                    observed,
                    extendedActions,
                    automaticUiOnly: !extendedEnabled,
                    measurementEnabled,
                    applicationCpuNotSubtracted: true,
                    timingsAreWallIntervalsNotOverlappingCommandSums: true,
                    explicitManagedEvaluationRequested: false,
                    automaticDisplayMayUseImplicitFunctionEvaluation: true,
                },
                null,
                2
            )
        );
    }
}
