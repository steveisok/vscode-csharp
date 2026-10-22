/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';

export interface DebuggerStopExpectation {
    sourceSuffix: string;
    line: number;
    localNames: string[];
    localValues?: Record<string, string>;
}

export interface DebuggerWorkload {
    id: 'small' | 'havit' | 'ios';
    workspace: string;
    handoff: string;
    assembly: string;
    // Browser workloads only; the iOS workload is launched by the .NET MAUI extension instead.
    url?: string;
    scenario?: string;
    stops: DebuggerStopExpectation[];
    preparationTransitions?: number;
    entry?: {
        selector: string;
        action?: 'input' | 'click';
        text?: string;
        expectedHrefSuffix?: string;
        expectedText?: string;
        minimumViewportWidth?: number;
        historyRoundTrip?: boolean;
        readyMarker?: string;
        initialRows?: string[];
        expectedRows?: string[];
    };
    server?: { command: string; args: string[] };
    // iOS only: the .NET MAUI extension launch configuration (project is relative to the staged workspace).
    launch?: { type: 'maui'; project: string; configuration: string; targetFramework: string };
    extendedInspection?: {
        notApplicable?: boolean;
        notApplicableReason?: string;
        callerFrameName?: string;
        callerLocals?: string[];
        callerLocalContains?: Record<string, string>;
        forbiddenLocals?: string[];
        thisMember?: string;
    };
}

export function parseDebuggerWorkload(value: unknown): DebuggerWorkload {
    if (!value || typeof value !== 'object') {
        throw new Error('Debugger workload must be an object.');
    }
    const config = value as Partial<DebuggerWorkload>;
    if (config.id !== 'small' && config.id !== 'havit' && config.id !== 'ios') {
        throw new Error('Select small, havit or ios.');
    }
    const required = config.id === 'ios' ? (['workspace', 'handoff', 'assembly'] as const) : (['workspace', 'handoff', 'assembly', 'url'] as const);
    for (const field of required) {
        if (typeof config[field] !== 'string' || !config[field]) {
            throw new Error(`Missing workload ${field}.`);
        }
    }
    for (const field of ['workspace', 'handoff'] as const) {
        const target = config[field]!;
        if (path.isAbsolute(target) || target.split(/[\\/]/).includes('..')) {
            throw new Error(`Workload ${field} must stay within prototype staging.`);
        }
    }
    if (config.id === 'ios') {
        const launch = config.launch;
        if (
            !launch ||
            launch.type !== 'maui' ||
            typeof launch.project !== 'string' ||
            path.isAbsolute(launch.project) ||
            launch.project.split(/[\\/]/).includes('..') ||
            typeof launch.configuration !== 'string' ||
            typeof launch.targetFramework !== 'string' ||
            !launch.targetFramework.endsWith('-ios')
        ) {
            throw new Error('The iOS workload requires a staged-relative .NET MAUI launch for an -ios target framework.');
        }
        if (config.url !== undefined || config.server !== undefined || config.entry !== undefined) {
            throw new Error('The iOS workload has no browser URL, owned server or DOM entry.');
        }
    } else {
        const url = new URL(config.url!);
        if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
            throw new Error('Debugger workload must use an owned loopback HTTP server.');
        }
    }
    if (!Array.isArray(config.stops) || config.stops.length < 2 || config.stops.length > 5) {
        throw new Error('Configure two to five existing synchronous sequence-point stops.');
    }
    if (
        config.preparationTransitions !== undefined &&
        (!Number.isInteger(config.preparationTransitions) ||
            config.preparationTransitions < 0 ||
            config.preparationTransitions >= config.stops.length - 1)
    ) {
        throw new Error('Preparation must leave at least one synchronous transition to measure.');
    }
    for (const stop of config.stops) {
        if (
            !stop ||
            typeof stop.sourceSuffix !== 'string' ||
            !stop.sourceSuffix ||
            !Number.isInteger(stop.line) ||
            stop.line < 1 ||
            !Array.isArray(stop.localNames) ||
            !stop.localNames.length ||
            stop.localNames.some((name) => typeof name !== 'string' || !name)
        ) {
            throw new Error('Each stop requires source, positive line and baseline local identities.');
        }
        if (
            stop.localValues &&
            (typeof stop.localValues !== 'object' ||
                Object.values(stop.localValues).some((value) => typeof value !== 'string'))
        ) {
            throw new Error('Expected local values must be debugger display strings.');
        }
    }
    if (config.entry) {
        if (typeof config.entry.selector !== 'string' || !config.entry.selector) {
            throw new Error('Workload entry requires an existing UI selector.');
        }
        if (config.entry.action !== undefined && !['input', 'click'].includes(config.entry.action)) {
            throw new Error('Workload entry must use normal input or anchor click.');
        }
        if (config.entry.action === 'click') {
            if (
                typeof config.entry.expectedHrefSuffix !== 'string' ||
                !config.entry.expectedHrefSuffix.startsWith('#')
            ) {
                throw new Error('Navigation entry requires an expected existing fragment anchor.');
            }
        } else if (typeof config.entry.text !== 'string' || !config.entry.text) {
            throw new Error('Input entry requires a nonempty value.');
        }
        if (config.entry.expectedText !== undefined && typeof config.entry.expectedText !== 'string') {
            throw new Error('Expected anchor text must be a string.');
        }
        if (
            config.entry.minimumViewportWidth !== undefined &&
            (!Number.isInteger(config.entry.minimumViewportWidth) || config.entry.minimumViewportWidth < 1)
        ) {
            throw new Error('Minimum browser viewport width must be positive.');
        }
        if (
            config.entry.historyRoundTrip !== undefined &&
            (typeof config.entry.historyRoundTrip !== 'boolean' || config.entry.action !== 'click')
        ) {
            throw new Error('Ordinary history navigation requires an anchor click entry.');
        }
        for (const field of ['initialRows', 'expectedRows'] as const) {
            if (
                config.entry[field] &&
                (!Array.isArray(config.entry[field]) || config.entry[field]!.some((row) => typeof row !== 'string'))
            ) {
                throw new Error('Entry row observations must be strings.');
            }
        }
    }
    if (
        config.server &&
        (typeof config.server.command !== 'string' ||
            !Array.isArray(config.server.args) ||
            config.server.args.some((arg) => typeof arg !== 'string'))
    ) {
        throw new Error('Invalid owned server command.');
    }
    return config as DebuggerWorkload;
}

export function assertRunnableWorkload(handoff: unknown): void {
    if (
        !handoff ||
        typeof handoff !== 'object' ||
        !('explicitRunnableHandoff' in handoff) ||
        handoff.explicitRunnableHandoff !== true
    ) {
        throw new Error('Explicit runnable debugger workload handoff is required before launch.');
    }
}
