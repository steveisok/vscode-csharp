/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Opt-in comparison workflow (machine config workflowSequence: "comparison"). It follows the 16-row user workflow of
// the internal debugger-performance-comparison.md: launch and first user break, inspection, resume to a second user
// break, repeated inspection, then a final Step Over. The original harness is unavailable, so the start/end events
// below are inferred and recorded as such.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
    ComparisonBreak,
    DebuggerStopExpectation,
    DebuggerWorkload,
    parseComparisonWorkflow,
} from './debuggerWorkload';
import type { TimedDebuggerRequest } from './automaticDebuggerSteps';
import { ExtendedInspectionContext, launchAndBreakTimings } from './extendedInspection';

type Message = { session: string; message: Record<string, unknown>; at?: number };
type Frame = { id: number; name: string; line: number; column: number; source?: { path?: string } };
type Variable = { name: string; value: string; type?: string; variablesReference: number };

export const comparisonDefinitions = {
    inferred: true,
    'Launch -> first pause':
        'harness vscode.debug.startDebugging call -> first managed stopped event (validated at break 1)',
    'User break -> pause':
        'Havit: scripted Forward Page.navigateToHistoryEntry issued -> stopped at break 1; Small: managed configurationDone sent -> stopped (supplementary: last module event -> stopped)',
    'Load Locals scope': 'automatic DAP scopes(top frame) request -> response',
    'Expand Locals':
        'mouse click on the expandable top-frame local twistie -> max(DAP variables(local) response, first child row visible)',
    'Load call stack':
        'automatic first DAP stackTrace request after the stop -> response (all stackTrace requests kept raw)',
    'Select caller frame':
        'mouse click on the caller row in Call Stack -> caller row first rendered selected (UI only)',
    'Load caller Locals':
        'DAP scopes(caller frame) request -> max(DAP variables(caller Locals) response, caller Locals first visible)',
    'Expand caller `this`':
        'mouse click on the this twistie -> max(DAP variables(this) response, expected field first visible)',
    'Resume -> second user break': 'DAP continue request (issued by the Continue command) -> stopped at break 2',
    'Step Over -> stopped':
        'DAP next request (issued by the Step Over command) -> next managed stopped event (final action)',
    automaticExpansionFallback:
        'If VS Code restored an expansion automatically, no click is made: the value is measured from the stop (top-frame local) or the caller click (this) to the DAP variables response and labelled automatic-restored.',
    untimedCleanupBetweenBreaks:
        'After break-1 inspection, the harness collapses the expanded this and top-frame local (and reselects the top frame) before resuming, so break-2 expansions are real clicks; these UI actions are untimed and recorded.',
    bounds: { inspectionTimeoutMs: 30000, quiescenceMs: 300, pollMs: 25 },
};

export async function measureComparisonWorkflow(
    session: vscode.DebugSession,
    workload: DebuggerWorkload,
    prototype: string,
    run: string,
    messages: Message[],
    requests: TimedDebuggerRequest[],
    stopTimes: number[],
    pending: Map<number, TimedDebuggerRequest>,
    context: ExtendedInspectionContext
) {
    const config = parseComparisonWorkflow(workload.comparison);
    const measurementEnabled = process.env.WASM_PROTOTYPE_MEASUREMENT_ENABLED !== '0';
    const observed: object[] = [];
    const steps: object[] = [];
    const actions: Record<string, unknown>[] = [];
    const cleanup: object[] = [];
    const prototypeNode = process.env.WASM_PROTOTYPE_NODE;
    const uiPort = process.env.WASM_PROTOTYPE_UI_PORT;
    if (!prototypeNode || !uiPort) {
        throw new Error('Owned UI inspection port and Node executable required.');
    }
    const responseFor = (request: TimedDebuggerRequest | undefined) =>
        messages.find(({ message }) => message.type === 'response' && message.request_seq === request?.sequence)
            ?.message;
    const dapBetween = (from: number, to: number) =>
        requests
            .filter((r) => r.startedAt >= from && r.startedAt <= to)
            .map((r) => ({
                command: r.command,
                sequence: r.sequence,
                arguments: r.arguments,
                startedAtMs: r.startedAt - from,
                finishedAtMs: r.finishedAt === undefined ? undefined : r.finishedAt - from,
                success: r.success,
            }));
    const record = (phase: string, operation: string, ms: number | undefined, extra: Record<string, unknown> = {}) =>
        actions.push({ phase, operation, ms, ...extra });
    const notApplicable = (phase: string, operation: string, reasonKey: string = operation) =>
        actions.push({
            phase,
            operation,
            notApplicable: true,
            reason: config.notApplicable?.[reasonKey] ?? config.notApplicable?.default ?? 'Not applicable.',
        });
    const nameMatches = (name: string, wanted: string) => name === wanted || name.startsWith(`${wanted} `);

    async function capture(label: string, stop?: DebuggerStopExpectation) {
        await promisify(execFile)(
            prototypeNode!,
            [
                path.join(prototype, 'captureUi.js'),
                uiPort!,
                path.join(run, label),
                ...(stop ? [JSON.stringify(stop)] : []),
            ],
            { timeout: 12000 }
        );
        return JSON.parse(fs.readFileSync(path.join(run, `${label}.json`), 'utf8')) as {
            renderedUiObservedAtEpochMs: number;
        };
    }
    async function act(label: string, uiSpec: Record<string, unknown>) {
        const output = path.join(run, label);
        await promisify(execFile)(
            prototypeNode!,
            [path.join(prototype, 'uiInspectAction.js'), uiPort!, output, JSON.stringify(uiSpec)],
            { timeout: 45000 }
        );
        const ui = JSON.parse(fs.readFileSync(`${output}.json`, 'utf8'));
        const toHost = (epochMs: number | undefined) =>
            epochMs === undefined ? undefined : epochMs - context.epochOffsetMs;
        return {
            ui,
            actionAt: toHost(ui.actionEpochMs) as number,
            firstVisible: (condition: string) => toHost(ui.conditions?.[condition]?.firstVisibleEpochMs) as number,
            alreadyExpanded: ui.alreadyExpanded === true,
        };
    }
    // Same correctness gate as F10 mode: automatic Call Stack + baseline Locals at this stop, 300 ms quiet.
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
                    { scopes: { name: string; variablesReference: number; expensive: boolean }[] } | undefined);
            const scope = scopes?.scopes.find((s) => /locals/i.test(s.name) && !s.expensive);
            const variables =
                scope &&
                (response('variables', (args) => args.variablesReference === scope.variablesReference)?.body as
                    { variables: Variable[] } | undefined);
            const busy = [...pending.values()].some((r) =>
                ['threads', 'stackTrace', 'scopes', 'variables'].includes(r.command)
            );
            if (frame && scope && variables && !busy) {
                if (!frame.source?.path?.endsWith(expected.sourceSuffix) || frame.line !== expected.line) {
                    throw new Error(`Unexpected source stop: ${JSON.stringify(frame)}.`);
                }
                for (const name of expected.localNames) {
                    const variable = variables.variables.find((v) => nameMatches(v.name, name));
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
                    const ui = await capture(`cmp-stop-${stopIndex}-ui`, expected);
                    return {
                        stop: stop.message.body,
                        frames: stack!.stackFrames,
                        frame,
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
        throw new Error('Automatic Call Stack/Locals did not complete within the shared 30s bound.');
    }
    async function waitForStop(index: number, command: string, boundMs: number) {
        const deadline = Date.now() + boundMs;
        while (stopTimes.length <= index && Date.now() < deadline) {
            const failed = messages.find(
                ({ message }) => message.type === 'response' && message.command === command && !message.success
            );
            if (failed) {
                throw new Error(`${command} failed: ${JSON.stringify(failed.message)}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (stopTimes.length <= index) {
            throw new Error(`${command} produced no managed stop within ${boundMs} ms.`);
        }
        return messages.filter(({ message }) => message.type === 'event' && message.event === 'stopped')[index].message
            .body as Record<string, unknown>;
    }
    async function inspectBreak(index: number, brk: ComparisonBreak) {
        const phase = index === 0 ? 'First break' : 'Second break';
        const stopAt = stopTimes[index];
        const auto = await inspect(index, brk);
        observed.push(auto);
        const autoRequests = requests.filter((r) => r.startedAt >= stopAt && r.startedAt <= auto.completedAt);
        const topScopes = autoRequests.find((r) => r.command === 'scopes' && r.arguments?.frameId === auto.frame.id);
        if (!topScopes?.finishedAt) {
            throw new Error('Automatic top-frame scopes request was not recorded.');
        }
        record(phase, 'Load Locals scope', topScopes.finishedAt - topScopes.startedAt, {
            stoppedToScopesAnsweredMs: topScopes.finishedAt - stopAt,
            dap: dapBetween(topScopes.startedAt, topScopes.finishedAt),
        });
        const stackTraces = autoRequests.filter((r) => r.command === 'stackTrace');
        if (!stackTraces[0]?.finishedAt) {
            throw new Error('Automatic stackTrace request was not recorded.');
        }
        record(phase, 'Load call stack', stackTraces[0].finishedAt - stackTraces[0].startedAt, {
            allStackTraceRequestsMs: stackTraces.map((r) => (r.finishedAt ?? NaN) - r.startedAt),
            stoppedToLastStackTraceAnsweredMs: Math.max(...stackTraces.map((r) => r.finishedAt ?? 0)) - stopAt,
            automaticInspection: { stoppedToCorrectLocalsMs: auto.completedAt - stopAt },
            dap: dapBetween(stopAt, auto.completedAt),
        });
        const label = `cmp-b${index + 1}`;
        if (brk.expandLocal) {
            const local = auto.variables.find((v) => nameMatches(v.name, brk.expandLocal!.variable));
            if (!local?.variablesReference) {
                throw new Error(`Top-frame local ${brk.expandLocal.variable} is not expandable.`);
            }
            const r = await act(`${label}-expand-local`, {
                kind: 'expandVariable',
                variable: brk.expandLocal.variable,
                child: brk.expandLocal.child,
                ifAlreadyExpanded: 'report',
            });
            const from = r.alreadyExpanded ? stopAt : r.actionAt - 5;
            const vars = requests.find(
                (q) =>
                    q.startedAt >= from &&
                    q.command === 'variables' &&
                    q.arguments?.variablesReference === local.variablesReference
            );
            if (!vars?.finishedAt || !vars.success) {
                throw new Error(`No successful variables(${brk.expandLocal.variable}) response.`);
            }
            record(
                phase,
                'Expand Locals',
                r.alreadyExpanded
                    ? vars.finishedAt - stopAt
                    : Math.max(vars.finishedAt, r.firstVisible('childVisible')) - r.actionAt,
                {
                    mode: r.alreadyExpanded ? 'automatic-restored (no click; from stop)' : 'click',
                    clickToVariablesAnsweredMs: r.alreadyExpanded ? undefined : vars.finishedAt - r.actionAt,
                    clickToChildVisibleMs: r.alreadyExpanded ? undefined : r.firstVisible('childVisible') - r.actionAt,
                    dap: r.alreadyExpanded
                        ? dapBetween(vars.startedAt, vars.finishedAt)
                        : dapBetween(r.actionAt - 5, Math.max(vars.finishedAt, r.firstVisible('childVisible'))),
                }
            );
        } else {
            notApplicable(phase, 'Expand Locals');
        }
        if (brk.caller) {
            const caller = auto.frames.find((f, i) => i > 0 && f.name.includes(brk.caller!.frameName));
            if (!caller) {
                throw new Error(`Caller frame ${brk.caller.frameName} not in the stack.`);
            }
            const select = await act(`${label}-select-caller`, {
                kind: 'selectCaller',
                callerFrameName: brk.caller.frameName,
                callerLocals: brk.caller.callerLocals,
                callerLocalContains: brk.caller.callerLocalContains,
                forbiddenLocals: brk.caller.forbiddenLocals,
            });
            const selectedAt = select.firstVisible('callerFrameSelected');
            const localsVisibleAt = select.firstVisible('callerLocalsVisible');
            record(phase, 'Select caller frame', selectedAt - select.actionAt, {
                callerFrame: caller.name,
                dap: dapBetween(select.actionAt - 5, selectedAt),
            });
            const callerScopes = requests.find(
                (q) =>
                    q.startedAt >= select.actionAt - 5 && q.command === 'scopes' && q.arguments?.frameId === caller.id
            );
            const scopeBody = responseFor(callerScopes)?.body as
                { scopes?: { name: string; variablesReference: number }[] } | undefined;
            const localsScope = scopeBody?.scopes?.find((s) => /locals/i.test(s.name));
            const callerVars =
                localsScope &&
                requests.find(
                    (q) =>
                        q.startedAt >= select.actionAt - 5 &&
                        q.command === 'variables' &&
                        q.arguments?.variablesReference === localsScope.variablesReference
                );
            if (!callerScopes?.finishedAt || !callerVars?.finishedAt || !callerVars.success) {
                throw new Error('Caller frame selection did not produce successful caller scopes/Locals.');
            }
            const callerVariables =
                (responseFor(callerVars)?.body as { variables?: Variable[] } | undefined)?.variables ?? [];
            const thisVariable = callerVariables.find((v) => nameMatches(v.name, 'this'));
            if (!thisVariable?.variablesReference) {
                throw new Error('Caller Locals have no expandable this.');
            }
            record(
                phase,
                'Load caller Locals',
                Math.max(callerVars.finishedAt, localsVisibleAt) - callerScopes.startedAt,
                {
                    clickToScopesRequestMs: callerScopes.startedAt - select.actionAt,
                    scopesToVariablesAnsweredMs: callerVars.finishedAt - callerScopes.startedAt,
                    scopesToLocalsVisibleMs: localsVisibleAt - callerScopes.startedAt,
                    clickToLocalsVisibleMs: localsVisibleAt - select.actionAt,
                    dap: dapBetween(select.actionAt - 5, Math.max(callerVars.finishedAt, localsVisibleAt)),
                }
            );
            const expand = await act(`${label}-expand-caller-this`, {
                kind: 'expandVariable',
                variable: 'this',
                child: brk.caller.thisMember,
                ifAlreadyExpanded: 'report',
            });
            const from = expand.alreadyExpanded ? select.actionAt - 5 : expand.actionAt - 5;
            const members = requests.find(
                (q) =>
                    q.startedAt >= from &&
                    q.command === 'variables' &&
                    q.arguments?.variablesReference === thisVariable.variablesReference
            );
            if (!members?.finishedAt || !members.success) {
                throw new Error('No successful variables(this) response.');
            }
            record(
                phase,
                'Expand caller `this`',
                expand.alreadyExpanded
                    ? members.finishedAt - select.actionAt
                    : Math.max(members.finishedAt, expand.firstVisible('childVisible')) - expand.actionAt,
                {
                    mode: expand.alreadyExpanded ? 'automatic-restored (no click; from caller click)' : 'click',
                    clickToVariablesAnsweredMs: expand.alreadyExpanded
                        ? undefined
                        : members.finishedAt - expand.actionAt,
                    clickToChildVisibleMs: expand.alreadyExpanded
                        ? undefined
                        : expand.firstVisible('childVisible') - expand.actionAt,
                    dap: dapBetween(
                        from,
                        Math.max(members.finishedAt, expand.alreadyExpanded ? 0 : expand.firstVisible('childVisible'))
                    ),
                }
            );
        } else {
            notApplicable(phase, 'Select caller frame');
            notApplicable(phase, 'Load caller Locals');
            notApplicable(phase, 'Expand caller `this`');
        }
        return auto;
    }
    async function cleanupBeforeResume(index: number, brk: ComparisonBreak, auto: { frame: Frame }) {
        const label = `cmp-b${index + 1}-cleanup`;
        const started = performance.now();
        if (brk.caller) {
            cleanup.push(
                (
                    await act(`${label}-collapse-this`, {
                        kind: 'collapseVariable',
                        variable: 'this',
                        child: brk.caller.thisMember,
                    })
                ).ui
            );
            const topName = auto.frame.name.split('!').pop()!.split('(')[0];
            cleanup.push((await act(`${label}-select-top`, { kind: 'selectFrame', frameName: topName })).ui);
        }
        if (brk.expandLocal) {
            cleanup.push(
                (
                    await act(`${label}-collapse-local`, {
                        kind: 'collapseVariable',
                        variable: brk.expandLocal.variable,
                        child: brk.expandLocal.child,
                    })
                ).ui
            );
        }
        // Let any refresh caused by the cleanup settle before resuming.
        let quietSince: number | undefined;
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            const busy = [...pending.values()].some((r) =>
                ['threads', 'stackTrace', 'scopes', 'variables'].includes(r.command)
            );
            quietSince = busy ? undefined : (quietSince ?? Date.now());
            if (quietSince !== undefined && Date.now() - quietSince >= 300) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        cleanup.push({ untimed: true, dap: dapBetween(started, performance.now()) });
    }

    try {
        const breakTimings = launchAndBreakTimings(workload, run, messages, requests, stopTimes, context);
        record('Launch', 'Launch -> first pause', breakTimings.launch.launchToInitialStopMs, {
            raw: breakTimings.launch,
        });
        const pause = breakTimings.pauseAtDebuggerBreak as Record<string, number | string | undefined>;
        record(
            'First break',
            'User break -> pause',
            (pause.triggerToStopMs ?? pause.configurationDoneToStopMs) as number,
            { raw: pause }
        );
        for (let index = 0; index < config.breaks.length; index++) {
            const auto = await inspectBreak(index, config.breaks[index]);
            if (index < config.breaks.length - 1) {
                await cleanupBeforeResume(index, config.breaks[index], auto);
                const commandStart = performance.now();
                await vscode.commands.executeCommand('workbench.action.debug.continue', session.id);
                const body = await waitForStop(index + 1, 'continue', 30000);
                const cont = requests.find((r) => r.startedAt >= commandStart - 1 && r.command === 'continue');
                if (!cont) {
                    throw new Error('Continue request was not recorded.');
                }
                record('Resume', 'Resume -> second user break', stopTimes[index + 1] - cont.startedAt, {
                    commandToStopMs: stopTimes[index + 1] - commandStart,
                    stopReason: body.reason,
                    dap: dapBetween(commandStart, stopTimes[index + 1]),
                });
            }
        }
        if (config.breaks.length < 2) {
            notApplicable('Resume', 'Resume -> second user break');
            for (const operation of [
                'Load Locals scope',
                'Expand Locals',
                'Load call stack',
                'Select caller frame',
                'Load caller Locals',
                'Expand caller `this`',
            ]) {
                notApplicable('Second break', operation, 'default');
            }
        }
        const stepIndex = config.breaks.length;
        const start = performance.now();
        const epoch = Date.now();
        await vscode.commands.executeCommand('workbench.action.debug.stepOver', session.id);
        const body = await waitForStop(stepIndex, 'next', 15000);
        if (body.reason !== 'step') {
            throw new Error(`Final stop is not step-complete: ${JSON.stringify(body)}`);
        }
        const next = requests.find((r) => r.startedAt >= start - 1 && r.command === 'next');
        if (!next) {
            throw new Error('Step Over request was not recorded.');
        }
        const refresh = await inspect(stepIndex, config.stepOverTo);
        observed.push(refresh);
        record('Final action', 'Step Over -> stopped', stopTimes[stepIndex] - next.startedAt, {
            commandToStopMs: stopTimes[stepIndex] - start,
            nextRequestMs: next.finishedAt === undefined ? undefined : next.finishedAt - next.startedAt,
            dap: dapBetween(start, stopTimes[stepIndex]),
        });
        // F10-compatible sample so the runner's existing step gate, sidecars and reports apply unchanged.
        steps.push({
            from: config.breaks[config.breaks.length - 1],
            to: config.stepOverTo,
            requestStartedAt: start,
            requestStartedAtEpochMs: epoch,
            commandToStopMs: measurementEnabled ? stopTimes[stepIndex] - start : undefined,
            commandToAutomaticInspectionMs: measurementEnabled ? refresh.completedAt - start : undefined,
            commandToVisibleRefreshObservationMs: measurementEnabled
                ? refresh.ui.renderedUiObservedAtEpochMs - epoch
                : undefined,
            measurementEnabled,
            inspectionTimeoutMs: 30000,
            inspectionQuiescenceMs: 300,
            UIObservationIncludesPollingQuiescenceAndCapture: true,
            baselineLocalsOnly: false,
            expandedObjects: true,
            comparisonWorkflowFinalStep: true,
        });
        return { steps, observed, automaticUiOnly: false, comparison: { actions, cleanup } };
    } catch (error) {
        await capture('capability-blocker-ui').catch(() => undefined);
        throw error;
    } finally {
        fs.writeFileSync(
            path.join(run, 'automatic-step-results.json'),
            JSON.stringify(
                {
                    batchId: process.env.WASM_PROTOTYPE_BATCH_ID,
                    runId: process.env.WASM_PROTOTYPE_RUN_ID,
                    workload,
                    workflowSequence: 'comparison',
                    steps,
                    observed,
                    comparison: { definitions: comparisonDefinitions, actions, cleanup },
                    automaticUiOnly: false,
                    measurementEnabled,
                    applicationCpuNotSubtracted: true,
                    automaticDisplayMayUseImplicitFunctionEvaluation: true,
                },
                null,
                2
            )
        );
    }
}
