/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, execFile, spawn } from 'child_process';
import { promisify } from 'util';

export function ownedCleanupCommand(
    platform: string,
    pid: number,
    force: boolean
): { command: string; args: string[] } | { group: number; signal: 'SIGTERM' | 'SIGKILL' } {
    if (!Number.isInteger(pid) || pid < 1) {
        throw new Error('Owned cleanup requires an exact positive PID.');
    }
    if (platform === 'win32') {
        return { command: 'taskkill', args: ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])] };
    }
    if (platform !== 'darwin' && platform !== 'linux') {
        throw new Error(`Unsupported owned-process cleanup platform: ${platform}`);
    }
    return { group: -pid, signal: force ? ('SIGKILL' as const) : ('SIGTERM' as const) };
}

export function ownedSpawnOptions(platform: string) {
    return { detached: platform !== 'win32', windowsHide: true, shell: false };
}

export async function stopOwned(child: ChildProcess, platform = process.platform): Promise<void> {
    if (!child.pid) {
        return;
    }
    const exited = child.exitCode !== null || child.signalCode !== null;
    // A POSIX group can retain descendants after its leader exits; signal only our detached group.
    async function terminate(force: boolean) {
        const action = ownedCleanupCommand(platform, child.pid!, force);
        if ('command' in action) {
            if (exited) {
                return;
            }
            try {
                await promisify(execFile)(action.command, action.args, { windowsHide: true });
            } catch (error) {
                // Windowless console helpers refuse a non-forced taskkill; the bounded wait below escalates to /F.
                if (force) {
                    throw error;
                }
            }
        } else {
            try {
                process.kill(action.group, action.signal);
            } catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
                    throw error;
                }
            }
        }
    }
    await terminate(false);
    if (exited) {
        if (platform !== 'win32') {
            await terminate(true);
        }
        return;
    }
    const closed = await new Promise<boolean>((resolve) => {
        const onClose = () => {
            clearTimeout(timer);
            resolve(true);
        };
        const timer = setTimeout(() => {
            child.removeListener('close', onClose);
            resolve(false);
        }, 3000);
        child.once('close', onClose);
        if (child.exitCode !== null || child.signalCode !== null) {
            child.removeListener('close', onClose);
            clearTimeout(timer);
            resolve(true);
        }
    });
    if (!closed || platform !== 'win32') {
        await terminate(true);
    }
}

export class OwnedProcesses {
    readonly children: ChildProcess[] = [];
    private stopping?: Promise<void>;
    private interrupted = false;
    private readonly signalHandler = () => {
        this.interrupted = true;
        console.error(
            'Prototype interrupted: stopping owned helper process trees; run remains incomplete unless finalized.'
        );
        void this.stop()
            .then(() => {
                process.exitCode = 130;
            })
            .catch((error) => {
                console.error('Owned cleanup failed:', error);
                process.exitCode = 1;
            });
    };
    constructor() {
        process.once('SIGINT', this.signalHandler);
        process.once('SIGTERM', this.signalHandler);
    }
    spawn(command: string, args: string[], options: Parameters<typeof spawn>[2] = {}) {
        if (this.interrupted || this.stopping) {
            throw new Error('Owned launcher is stopping; no new helpers may be spawned.');
        }
        const child = spawn(command, args, { ...options, ...ownedSpawnOptions(process.platform) });
        child.on('error', (error) => console.error(`Owned helper ${command} could not start:`, error));
        this.children.push(child);
        return child;
    }
    async stop(): Promise<void> {
        this.stopping ??= (async () => {
            const errors: unknown[] = [];
            for (const child of [...this.children].reverse()) {
                try {
                    await stopOwned(child);
                } catch (error) {
                    console.error(`Failed to stop owned PID ${child.pid}:`, error);
                    errors.push(error);
                }
            }
            if (errors.length) {
                throw new AggregateError(errors, 'Owned process cleanup failed; every helper was attempted.');
            }
        })();
        return this.stopping;
    }
    dispose(): void {
        process.removeListener('SIGINT', this.signalHandler);
        process.removeListener('SIGTERM', this.signalHandler);
    }
}
