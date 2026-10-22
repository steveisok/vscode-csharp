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
import { execFile } from 'child_process';
import { promisify } from 'util';
import { assertRunnableWorkload, parseDebuggerWorkload } from './debuggerWorkload';
import { measureAutomaticDebuggerSteps, TimedDebuggerRequest } from './automaticDebuggerSteps';

const prototypeDirectory = process.env.WASM_PROTOTYPE_DIRECTORY;
const testIos = prototypeDirectory && process.env.IOS_PROTOTYPE_DEVICE ? test : test.skip;
// Session types whose adapter is the managed debugger (the MAUI provider rewrites CoreCLR launches to coreclr_mobile).
const managedSessionTypes = new Set(['coreclr_mobile', 'monovsdbg', 'coreclr']);
const LAUNCH_BOUND_MS = Number(process.env.IOS_PROTOTYPE_LAUNCH_BOUND_MS ?? 600000);

// Records visible workbench notifications and a screenshot over the owned workbench CDP port (diagnostic only).
async function captureWorkbenchNotifications(output: string) {
    try {
        const port = process.env.WASM_PROTOTYPE_UI_PORT;
        const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
            type: string;
            url: string;
            webSocketDebuggerUrl: string;
        }[];
        const target = targets.find((t) => t.type === 'page' && t.url.includes('workbench'));
        if (!target) {
            throw new Error('workbench target not found');
        }
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true });
            socket.addEventListener('error', reject, { once: true });
        });
        let id = 0;
        const send = (method: string, params: object = {}) =>
            new Promise<any>((resolve) => {
                const current = ++id;
                const listener = (event: MessageEvent) => {
                    const message = JSON.parse(String(event.data));
                    if (message.id === current) {
                        socket.removeEventListener('message', listener);
                        resolve(message.result);
                    }
                };
                socket.addEventListener('message', listener);
                socket.send(JSON.stringify({ id: current, method, params }));
            });
        const notifications = await send('Runtime.evaluate', {
            expression:
                "JSON.stringify([...document.querySelectorAll('.notification-list-item')].map(e => e.innerText))",
            returnByValue: true,
        });
        const image = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        fs.writeFileSync(`${output}.json`, JSON.stringify({ notifications: JSON.parse(notifications.result.value) }, null, 2));
        fs.writeFileSync(`${output}.png`, Buffer.from(image.data, 'base64'));
        socket.close();
    } catch (error) {
        fs.writeFileSync(`${output}.json`, JSON.stringify({ captureFailure: String(error) }, null, 2));
    }
}

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
        const lifecycle: { event: string; type: string; session: string; at: number; detail?: unknown }[] = [];
        let failure: string | undefined;
        let launchStartedAt: number | undefined;
        let stepCapabilitiesCheckPassed = false;
        let automaticSteps: Awaited<ReturnType<typeof measureAutomaticDebuggerSteps>> | undefined;
        let managedSessionId: string | undefined;
        let loadedImages: unknown;
        // Untimed capability runs only: timestamp the app's [cDAC]/CORDBG stderr lines as mlaunch relays them.
        const appStderrEvents: { at: number; line: string }[] = [];
        let stderrTail: ReturnType<typeof setInterval> | undefined;
        if (process.env.IOS_PROTOTYPE_TAIL_APP_STDERR === '1' && process.env.IOS_PROTOTYPE_PROFILE) {
            const offsets = new Map<string, number>();
            const partial = new Map<string, string>();
            const logs = path.join(process.env.IOS_PROTOTYPE_PROFILE, 'logs');
            const findMlaunchLogs = (directory: string): string[] =>
                !fs.existsSync(directory)
                    ? []
                    : fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
                          const file = path.join(directory, entry.name);
                          return entry.isDirectory() ? findMlaunchLogs(file) : /^mlaunch-.*\.log$/.test(entry.name) ? [file] : [];
                      });
            stderrTail = setInterval(() => {
                for (const file of findMlaunchLogs(logs)) {
                    const size = fs.statSync(file).size;
                    const from = offsets.get(file) ?? 0;
                    if (size <= from) {
                        continue;
                    }
                    const fd = fs.openSync(file, 'r');
                    const buffer = Buffer.alloc(size - from);
                    fs.readSync(fd, buffer, 0, buffer.length, from);
                    fs.closeSync(fd);
                    offsets.set(file, size);
                    const text = (partial.get(file) ?? '') + buffer.toString('utf8');
                    const lines = text.split('\n');
                    partial.set(file, lines.pop() ?? '');
                    const at = performance.now();
                    for (const line of lines) {
                        if (/\[cDAC\]|CORDBG|cdac/i.test(line)) {
                            appStderrEvents.push({ at, line });
                        }
                    }
                }
            }, 50);
        }
        const appEnvironment: Record<string, string> = JSON.parse(process.env.IOS_PROTOTYPE_APP_ENV ?? '{}');
        const diagnosticLaunchOptions: Record<string, unknown> = JSON.parse(process.env.IOS_PROTOTYPE_DIAGNOSTIC_LAUNCH_OPTIONS ?? '{}');
        const captureAppImages = async () => {
            const run = async (file: string, args: string[]) =>
                (await promisify(execFile)(file, args, { timeout: 20000, maxBuffer: 16 * 1024 * 1024 })).stdout;
            try {
                const pids = (await run('/usr/bin/pgrep', ['-f', 'IosDebuggee.app/IosDebuggee'])).trim().split(/\s+/);
                const result: Record<string, string[]> = {};
                for (const pid of pids.filter(Boolean)) {
                    const lsof = await run('/usr/sbin/lsof', ['-p', pid, '-Fn']);
                    result[pid] = lsof
                        .split('\n')
                        .filter((l) => l.startsWith('n') && /\.dylib$/.test(l))
                        .map((l) => l.slice(1))
                        .filter((l) => /mscordaccore|mscordbi|coreclr|vsdbgremote/.test(l));
                }
                return { capturedAfterMeasuredActions: true, processes: result };
            } catch (error) {
                return { captureFailure: String(error) };
            }
        };

        // Passive observer: records each configuration-resolution stage; returns every configuration unchanged.
        const resolutions: { stage: string; type: unknown; at: number; keys: string[]; coreClrMobileDebuggerOptions?: unknown; program?: unknown }[] = [];
        const observe = (stage: string, configuration: vscode.DebugConfiguration) => {
            resolutions.push({
                stage,
                type: configuration?.type,
                at: performance.now(),
                keys: Object.keys(configuration ?? {}).sort(),
                coreClrMobileDebuggerOptions: configuration?.coreClrMobileDebuggerOptions,
                program: configuration?.program,
            });
            return configuration;
        };
        disposables.push(
            vscode.debug.registerDebugConfigurationProvider('*', {
                resolveDebugConfiguration: (_folder, configuration) => observe('resolve', configuration),
                resolveDebugConfigurationWithSubstitutedVariables: (_folder, configuration) =>
                    observe('resolveWithSubstitutedVariables', configuration),
            }),
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
            vscode.debug.onDidTerminateDebugSession((session) =>
                lifecycle.push({ event: 'didTerminateSession', type: session.type, session: session.id, at: performance.now() })
            ),
            vscode.debug.registerDebugAdapterTrackerFactory('*', {
                createDebugAdapterTracker(session) {
                    const note = (event: string, detail?: unknown) =>
                        lifecycle.push({ event, type: session.type, session: session.id, at: performance.now(), detail });
                    note('createTracker');
                    const lifecycleHooks = {
                        onWillStartSession: () => note('willStartSession'),
                        onWillStopSession: () => note('willStopSession'),
                        onExit: (code: number | undefined, signal: string | undefined) => note('adapterExit', { code, signal }),
                    };
                    if (!managedSessionTypes.has(session.type)) {
                        return {
                            ...lifecycleHooks,
                            onError: (error: Error) => note('adapterError', String(error)),
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
                        ...lifecycleHooks,
                        onError(error) {
                            note('adapterError', String(error));
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
            // Untimed readiness: the MAUI provider resolves the startup project from C# Dev Kit's project query, so wait
            // for this run's own Dev Kit log to report the query complete (bounded; failure is preserved, not retried).
            const profile = process.env.IOS_PROTOTYPE_PROFILE;
            if (!profile) {
                throw new Error('IOS_PROTOTYPE_PROFILE is required for the project-load readiness gate.');
            }
            const findDevKitLog = (directory: string): string | undefined => {
                for (const entry of fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }) : []) {
                    const file = path.join(directory, entry.name);
                    if (entry.isDirectory()) {
                        const found = findDevKitLog(file);
                        if (found) {
                            return found;
                        }
                    } else if (entry.name === 'C# Dev Kit.log') {
                        return file;
                    }
                }
                return undefined;
            };
            const projectReadyBound = Number(process.env.IOS_PROTOTYPE_PROJECT_READY_BOUND_MS ?? 300000);
            const projectReadyDeadline = Date.now() + projectReadyBound;
            let projectReadyAt: number | undefined;
            while (Date.now() < projectReadyDeadline) {
                const log = findDevKitLog(path.join(profile, 'logs'));
                if (log && fs.readFileSync(log, 'utf8').includes('Completed: Query for all projects')) {
                    projectReadyAt = performance.now();
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
            if (projectReadyAt === undefined) {
                throw new Error(`C# Dev Kit did not complete its project query within ${projectReadyBound} ms.`);
            }
            const projectSettle = Number(process.env.IOS_PROTOTYPE_PROJECT_SETTLE_MS ?? 5000);
            await new Promise((resolve) => setTimeout(resolve, projectSettle));
            fs.writeFileSync(
                path.join(run, 'project-readiness.json'),
                JSON.stringify(
                    { gate: 'C# Dev Kit log: Completed: Query for all projects', untimed: true, projectSettleMsAfterGate: projectSettle, boundMs: projectReadyBound },
                    null,
                    2
                )
            );
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
                // The MAUI provider passes these to the app as mlaunch --setenv (SIMCTL_CHILD_*).
                ...(Object.keys(appEnvironment).length
                    ? { environmentVariables: Object.entries(appEnvironment).map(([k, v]) => `${k}=${v}`).join('\n') }
                    : {}),
                ...diagnosticLaunchOptions,
            };
            fs.writeFileSync(path.join(run, 'maui-launch-configuration.json'), JSON.stringify(launch, null, 2));
            launchStartedAt = performance.now();
            const started = await vscode.debug.startDebugging(workspace, launch);
            if (!started) {
                await captureWorkbenchNotifications(path.join(run, 'start-debugging-false'));
            }
            expect(started).toBe(true);

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
                    // After all measured actions: record which images the app process has loaded (untimed evidence).
                    loadedImages = await captureAppImages();
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
                        appEnvironment,
                        appStderrEvents: appStderrEvents.map((e) => ({
                            ...e,
                            atMs: launchStartedAt === undefined ? undefined : e.at - launchStartedAt,
                        })),
                        appStderrTimestamped: process.env.IOS_PROTOTYPE_TAIL_APP_STDERR === '1',
                        loadedImages: loadedImages ?? (failure ? await captureAppImages() : undefined),
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
                        sessionLifecycle: lifecycle.map((l) => ({
                            ...l,
                            atMs: launchStartedAt === undefined ? undefined : l.at - launchStartedAt,
                        })),
                        configurationResolutions: resolutions.map((r) => ({
                            ...r,
                            atMs: launchStartedAt === undefined ? undefined : r.at - launchStartedAt,
                        })),
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
            if (stderrTail) {
                clearInterval(stderrTail);
            }
            await vscode.debug.stopDebugging();
            disposables.forEach((disposable) => disposable.dispose());
        }
    },
    Number(process.env.IOS_PROTOTYPE_TEST_TIMEOUT_MS ?? 1200000)
);
