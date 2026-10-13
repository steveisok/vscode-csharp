/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DebugAdapterExecutableFactory, validatePrototypeDebuggerPackage } from '../../../src/coreclrDebug/activate';
import { CoreClrDebugUtil } from '../../../src/coreclrDebug/util';
import { PlatformInformation } from '../../../src/shared/platform';
import { EventStream } from '../../../src/eventStream';
import { setExtensionPath } from '../../../src/common';

jest.mock('vscode', () => {
    const { getFakeVsCode, getNullChannel } = jest.requireActual<typeof import('../../fakes')>('../../fakes');
    const fake = getFakeVsCode();
    return {
        ...fake,
        window: { ...fake.window, createOutputChannel: jest.fn(getNullChannel) },
        DebugAdapterServer: class {
            constructor(
                public port: number,
                public host: string
            ) {}
        },
    };
});

let root: string;
let previous: string | undefined;
const platform = new PlatformInformation('darwin', 'arm64');
beforeEach(() => {
    root = fs.mkdtempSync(path.join(process.cwd(), 'out/prototype-debugger-package-'));
    previous = process.env.VSCODE_CSHARP_WASMDBG_CONCORD;
    setExtensionPath(root);
    for (const name of ['vsdbg-ui', 'libvsdebugeng.impl.dylib']) {
        fs.writeFileSync(path.join(root, name), 'fixture');
        fs.chmodSync(path.join(root, name), 0o700);
    }
});
afterEach(() => {
    if (previous === undefined) {
        delete process.env.VSCODE_CSHARP_WASMDBG_CONCORD;
    } else {
        process.env.VSCODE_CSHARP_WASMDBG_CONCORD = previous;
    }
    fs.rmSync(root, { recursive: true });
});

function factory() {
    return new DebugAdapterExecutableFactory(
        new CoreClrDebugUtil(root),
        platform,
        new EventStream(),
        { runtimeDependencies: [] },
        root
    );
}
function session(type = 'coreclr_wasm', port: unknown = 4711): vscode.DebugSession {
    return {
        id: 'fixture',
        name: 'fixture',
        type,
        workspaceFolder: undefined,
        configuration: { name: 'fixture', type, request: 'launch', debugServer: port },
        customRequest: async () => undefined,
        getDebugProtocolBreakpoint: async () => undefined,
    };
}
test('explicit producer package connects via descriptor without local .debugger markers', async () => {
    process.env.VSCODE_CSHARP_WASMDBG_CONCORD = root;
    expect(await factory().createDebugAdapterDescriptor(session(), undefined)).toMatchObject({
        port: 4711,
        host: '127.0.0.1',
    });
    expect(fs.existsSync(path.join(root, '.debugger'))).toBe(false);
    expect(() => validatePrototypeDebuggerPackage('relative/package', platform)).toThrow('absolute');
    fs.unlinkSync(path.join(root, 'libvsdebugeng.impl.dylib'));
    await expect(factory().createDebugAdapterDescriptor(session(), undefined)).rejects.toThrow();
});
test('external package rejects an absent or invalid debugServer instead of downloading or spawning', async () => {
    process.env.VSCODE_CSHARP_WASMDBG_CONCORD = root;
    for (const port of [0, 65536, '4711', null]) {
        await expect(factory().createDebugAdapterDescriptor(session('coreclr_wasm', port), undefined)).rejects.toThrow(
            'debugServer'
        );
    }
});
test('ordinary sessions and non-opted-in browser sessions retain packaged debugger checks', async () => {
    delete process.env.VSCODE_CSHARP_WASMDBG_CONCORD;
    await expect(factory().createDebugAdapterDescriptor(session(), undefined)).rejects.toThrow('downloading packages');
    process.env.VSCODE_CSHARP_WASMDBG_CONCORD = root;
    await expect(factory().createDebugAdapterDescriptor(session('coreclr'), undefined)).rejects.toThrow(
        'downloading packages'
    );
});
