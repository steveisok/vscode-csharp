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
    id: 'small' | 'havit';
    workspace: string;
    handoff: string;
    assembly: string;
    url: string;
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
    extendedInspection?: {
        notApplicable?: boolean;
        notApplicableReason?: string;
        callerFrameName?: string;
        callerLocals?: string[];
        callerLocalContains?: Record<string, string>;
        forbiddenLocals?: string[];
        thisMember?: string;
    };
    comparison?: ComparisonWorkflow;
}

/** Opt-in comparison workflow: user breaks, per-break inspection, resume between breaks, final Step Over. */
export interface ComparisonBreak extends DebuggerStopExpectation {
    expandLocal?: { variable: string; child: string };
    caller?: {
        frameName: string;
        callerLocals: string[];
        callerLocalContains?: Record<string, string>;
        forbiddenLocals?: string[];
        thisMember: string;
        expectFragmentUrl?: boolean;
    };
}
export interface ComparisonWorkflow {
    breaks: ComparisonBreak[];
    stepOverTo: DebuggerStopExpectation;
    notApplicable?: Record<string, string>;
}

export function parseComparisonWorkflow(value: unknown): ComparisonWorkflow {
    const config = value as Partial<ComparisonWorkflow> | undefined;
    const stop = (s: unknown, label: string) => {
        const e = s as Partial<DebuggerStopExpectation> | undefined;
        if (
            !e ||
            typeof e.sourceSuffix !== 'string' ||
            !Number.isInteger(e.line) ||
            !Array.isArray(e.localNames) ||
            !e.localNames.length
        ) {
            throw new Error(`Comparison workflow ${label} requires source, line and baseline local names.`);
        }
    };
    if (!config || !Array.isArray(config.breaks) || config.breaks.length < 1 || config.breaks.length > 2) {
        throw new Error('Comparison workflow requires one or two user breaks.');
    }
    config.breaks.forEach((b, index) => {
        stop(b, `break ${index + 1}`);
        if (b.expandLocal && (typeof b.expandLocal.variable !== 'string' || typeof b.expandLocal.child !== 'string')) {
            throw new Error('expandLocal requires variable and child names.');
        }
        if (
            b.caller &&
            (typeof b.caller.frameName !== 'string' ||
                !Array.isArray(b.caller.callerLocals) ||
                typeof b.caller.thisMember !== 'string')
        ) {
            throw new Error('caller requires frameName, callerLocals and thisMember.');
        }
    });
    stop(config.stepOverTo, 'stepOverTo');
    return config as ComparisonWorkflow;
}

export function parseDebuggerWorkload(value: unknown): DebuggerWorkload {
    if (!value || typeof value !== 'object') {
        throw new Error('Debugger workload must be an object.');
    }
    const config = value as Partial<DebuggerWorkload>;
    if (config.id !== 'small' && config.id !== 'havit') {
        throw new Error('Select small or havit.');
    }
    for (const field of ['workspace', 'handoff', 'assembly', 'url'] as const) {
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
    const url = new URL(config.url!);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
        throw new Error('Debugger workload must use an owned loopback HTTP server.');
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
