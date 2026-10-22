/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// iOS Simulator CoreCLR workflow-mode measurement. The ordinary .NET MAUI extension F5 flow builds,
// installs and launches the app; the shipped C# extension vsdbg debugs it through the
// vsdbgremotecoreclrhost/target pair staged for the selected cohort. The harness only observes DAP
// traffic and drives the existing UI; it sends no raw stack/scopes/variables request.

import { expect, test } from '@jest/globals';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { assertRunnableWorkload, parseDebuggerWorkload } from './debuggerWorkload';
import { measureAutomaticDebuggerSteps, TimedDebuggerRequest } from './automaticDebuggerSteps';

const prototypeDirectory = process.env.WASM_PROTOTYPE_DIRECTORY;
const testIos = prototypeDirectory && process.env.IOS_PROTOTYPE_DEVICE ? test : test.skip;
// Session types whose adapter is the managed debugger (the MAUI provider rewrites CoreCLR launches to coreclr_mobile).
const managedSessionTypes = new Set(['coreclr_mobile', 'monovsdbg', 'coreclr']);
const LAUNCH_BOUND_MS = Number(process.env.IOS_PROTOTYPE_LAUNCH_BOUND_MS ?? 600000);

testIos(
    'The iOS Simulator workload launches through the .NET MAUI extension and completes its debugger scenario',
    async () => {
        const stage = prototypeDirectory!;
        const run = process.env.WASM_PROTOTYPE_RUN_DIRECTORY ?? stage;
        const workload = parseDebuggerWorkload(
            JSON.parse(fs.readFileSync(path.join(stage, 'workloads', 'ios.json'), 'utf8'))
        );
        if (workload.id !== 'ios' || !workload.launch) {
            throw new Error('The iOS runner requires the ios workload.');
        }
        assertRunnableWorkload(JSON.parse(fs.readFileSync(path.join(stage, workload.handoff), 'utf8')));
        const epochOffsetMs = Date.now() - performance.now();
        const messages: { session: string; message: Record<string, unknown>; at?: number }[] = [];
        const otherMessages: { session: string; type: string; message: Record<string, unknown>; at: number }[] = [];
        const timedRequests: TimedDebuggerRequest[] = [];
        const pending = new Map<number, TimedDebuggerRequest>();
        const stopTimes: number[] = [];
        const sessions: { id: string; type: string; name: string; startedAt: number; configuration: unknown }[] = [];
        const tasks: { name: string; event: string; at: number; exitCode?: number }[] = [];
        const disposables: vscode.Disposable[] = [];
        let failure: string | undefined;
        let launchStartedAt: number | undefined;
        let stepCapabilitiesCheckPassed = false;
        let automaticSteps: Awaited<ReturnType<typeof measureAutomaticDebuggerSteps>> | undefined;
        let managedSessionId: string | undefined;

        disposables.push(
            vscode.debug.onDidStartDebugSession((session) =>
                sessions.push({
                    id: session.id,
                    type: session.type,
                    name: session.name,
                    startedAt: performance.now(),
                    configuration: session.configuration,
                })
            ),
            vscode.tasks.onDidStartTaskProcess((e) =>
                tasks.push({ name: e.execution.task.name, event: 'start', at: performance.now() })
            ),
            vscode.tasks.onDidEndTaskProcess((e) =>
                tasks.push({ name: e.execution.task.name, event: 'end', at: performance.now(), exitCode: e.exitCode })
            ),
            vscode.debug.registerDebugAdapterTrackerFactory('*', {
                createDebugAdapterTracker(session) {
                    if (!managedSessionTypes.has(session.type)) {
                        return {
                            onDidSendMessage(message) {
                                otherMessages.push({ session: session.id, type: session.type, message, at: performance.now() });
                            },
                        };
                    }
                    if (managedSessionId && managedSessionId !== session.id) {
                        failure = `A second managed debug session ${session.type}/${session.id} started.`;
                    }
                    managedSessionId = session.id;
                    return {
                        onWillReceiveMessage(message) {
                            if (message.type === 'request') {
                                const record: TimedDebuggerRequest = {
                                    command: message.command,
                                    sequence: message.seq,
                                    arguments: message.arguments,
                                    startedAt: performance.now(),
                                };
                                timedRequests.push(record);
                                pending.set(record.sequence, record);
                            }
                        },
                        onDidSendMessage(message) {
                            messages.push({ session: session.id, message, at: performance.now() });
                            if (message.type === 'event' && message.event === 'stopped') {
                                stopTimes.push(performance.now());
                            }
                            if (message.type === 'response') {
                                const record = pending.get(message.request_seq);
                                if (record) {
                                    record.finishedAt = performance.now();
                                    record.success = message.success;
                                    pending.delete(message.request_seq);
                                }
                            }
                            if (message.type !== 'event' || message.event !== 'output') {
                                console.log('IOS CORECLR DAP: ' + JSON.stringify(message));
                            }
                        },
                        onError(error) {
                            failure = error.message;
                        },
                    };
                },
            })
        );
        try {
            // Untimed readiness: the shipped C#, C# Dev Kit and .NET MAUI extensions are active and the project is loaded.
            for (const id of ['ms-dotnettools.csharp', 'ms-dotnettools.csdevkit', 'ms-dotnettools.dotnet-maui']) {
                const extension = vscode.extensions.getExtension(id);
                if (!extension) {
                    throw new Error(`Required extension ${id} is not installed in the isolated extensions directory.`);
                }
                await extension.activate();
            }
            const readyDeadline = Date.now() + 120000;
            while (Date.now() < readyDeadline) {
                const commands = await vscode.commands.getCommands();
                if (commands.includes('vscode-maui.pickDebugTarget') && commands.includes('csharp.attachToProcess')) {
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
            await vscode.commands.executeCommand('workbench.view.debug');
            for (const command of (await vscode.commands.getCommands()).filter(
                (c) => /callstack|variables/i.test(c) && c.endsWith('.focus')
            )) {
                await vscode.commands.executeCommand(command);
            }
            const workspace = vscode.workspace.workspaceFolders?.[0];
            if (!workspace || workspace.uri.fsPath !== path.join(stage, workload.workspace)) {
                throw new Error(`Unexpected workspace ${workspace?.uri.fsPath}.`);
            }
            // The project system needs time to load before the MAUI provider can resolve the startup project.
            const projectSettle = Number(process.env.IOS_PROTOTYPE_PROJECT_SETTLE_MS ?? 20000);
            await new Promise((resolve) => setTimeout(resolve, projectSettle));
            const launch = {
                type: 'maui',
                request: 'launch',
                name: 'iOS CoreCLR debugger experiment',
                project: path.join(workspace.uri.fsPath, workload.launch.project),
                configuration: workload.launch.configuration,
                targetFramework: workload.launch.targetFramework,
                platform: 'ios',
                device: process.env.IOS_PROTOTYPE_DEVICE,
                preLaunchTask: 'maui: Build',
            };
            fs.writeFileSync(path.join(run, 'maui-launch-configuration.json'), JSON.stringify(launch, null, 2));
            launchStartedAt = performance.now();
            expect(await vscode.debug.startDebugging(workspace, launch)).toBe(true);

            const deadline = Date.now() + LAUNCH_BOUND_MS;
            while (Date.now() < deadline) {
                if (failure) {
                    throw new Error(failure);
                }
                const failed = messages.find(
                    ({ message }) =>
                        message.type === 'response' &&
                        !message.success &&
                        ['initialize', 'launch', 'attach', 'configurationDone'].includes(String(message.command))
                );
                if (failed) {
                    throw new Error('Managed request failed: ' + JSON.stringify(failed.message));
                }
                const failedTask = tasks.find((t) => t.event === 'end' && t.exitCode !== 0);
                if (failedTask) {
                    throw new Error(`MAUI task ${failedTask.name} exited ${failedTask.exitCode}.`);
                }
                const terminated = messages.find(
                    ({ message }) => message.type === 'event' && ['terminated', 'exited'].includes(String(message.event))
                );
                if (terminated && !stopTimes.length) {
                    throw new Error('The managed session ended before the Debugger.Break stop: ' + JSON.stringify(terminated.message));
                }
                const stopped = messages.find(({ message }) => message.type === 'event' && message.event === 'stopped');
                if (stopped) {
                    const session = vscode.debug.activeDebugSession?.id === stopped.session
                        ? vscode.debug.activeDebugSession
                        : undefined;
                    if (!session) {
                        throw new Error('The stopped managed session is not the active debug session.');
                    }
                    automaticSteps = await measureAutomaticDebuggerSteps(
                        session,
                        workload,
                        stage,
                        run,
                        messages,
                        timedRequests,
                        stopTimes,
                        pending,
                        { launchStartedAt, epochOffsetMs }
                    );
                    stepCapabilitiesCheckPassed = true;
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            throw new Error(`No managed Debugger.Break stop within the ${LAUNCH_BOUND_MS} ms launch bound.`);
        } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
            throw error;
        } finally {
            const managed = sessions.find((s) => s.id === managedSessionId);
            const taskEnds = tasks.filter((t) => t.event === 'end');
            fs.writeFileSync(
                path.join(run, 'managed-attach-result.json'),
                JSON.stringify(
                    {
                        batchId: process.env.WASM_PROTOTYPE_BATCH_ID,
                        runId: process.env.WASM_PROTOTYPE_RUN_ID,
                        workload,
                        validationMode: 'ios-maui-f5-automatic-ui',
                        stepCapabilitiesCheckPassed,
                        userBreakObserved: stopTimes.length > 0,
                        failure,
                        automaticSteps,
                        launchBreakdown:
                            launchStartedAt === undefined
                                ? undefined
                                : {
                                      definition:
                                          'startDebugging -> MAUI preLaunchTask (incremental build) end -> managed coreclr_mobile session start -> first stopped',
                                      startDebuggingToLastTaskEndMs: taskEnds.length
                                          ? taskEnds[taskEnds.length - 1].at - launchStartedAt
                                          : undefined,
                                      startDebuggingToManagedSessionMs: managed
                                          ? managed.startedAt - launchStartedAt
                                          : undefined,
                                      managedSessionToFirstStopMs:
                                          managed && stopTimes.length ? stopTimes[0] - managed.startedAt : undefined,
                                  },
                        tasks: tasks.map((t) => ({ ...t, atMs: launchStartedAt === undefined ? undefined : t.at - launchStartedAt })),
                        timedRequests,
                        messages,
                        otherSessionMessages: otherMessages,
                        sessions,
                        inspectionFailures: messages.filter(
                            ({ message }) => message.type === 'response' && message.success === false
                        ),
                        automaticInspectionOnly: true,
                        explicitInspectionRequests: 0,
                        uiDrivenExtendedInspection: process.env.WASM_PROTOTYPE_EXTENDED_ACTIONS === '1',
                        epochOffsetMs,
                        launchStartedAt,
                    },
                    null,
                    2
                )
            );
            await vscode.debug.stopDebugging();
            disposables.forEach((disposable) => disposable.dispose());
        }
    },
    Number(process.env.IOS_PROTOTYPE_TEST_TIMEOUT_MS ?? 1200000)
);
