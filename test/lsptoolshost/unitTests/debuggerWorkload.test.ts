/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, test } from '@jest/globals';
import { assertRunnableWorkload, parseDebuggerWorkload } from '../integrationTests/debuggerWorkload';

const small = {
    id: 'small',
    workspace: 'sample',
    handoff: 'sample/runtime-handoff.json',
    assembly: 'Wasm.Browser.Sample',
    url: 'http://127.0.0.1:8000/index.html',
    stops: [15, 16, 17].map((line) => ({ sourceSuffix: 'Program.cs', line, localNames: ['args'] })),
};
describe('Debugger workload gates', () => {
    test('keeps the small workload and selects a separate Havit configuration', () => {
        expect(parseDebuggerWorkload(small).id).toBe('small');
        expect(
            parseDebuggerWorkload({ ...small, id: 'havit', workspace: 'havit', assembly: 'Havit.Blazor.Documentation' })
                .id
        ).toBe('havit');
    });
    test.each(['unknown', '../havit', ''])('rejects invalid selector %s', (id) => {
        expect(() => parseDebuggerWorkload({ ...small, id })).toThrow();
    });
    test.each(['../outside', '/outside'])('rejects non-staged workspace %s', (workspace) => {
        expect(() => parseDebuggerWorkload({ ...small, workspace })).toThrow();
    });
    test('rejects non-loopback endpoints and unverified empty statement paths', () => {
        expect(() => parseDebuggerWorkload({ ...small, url: 'https://example.com' })).toThrow();
        expect(() => parseDebuggerWorkload({ ...small, stops: [] })).toThrow();
    });
    test('unready Havit cannot launch merely because its files exist', () => {
        expect(() => assertRunnableWorkload({ explicitRunnableHandoff: false })).toThrow();
        expect(() => assertRunnableWorkload({ filesPresent: true })).toThrow();
        expect(() => assertRunnableWorkload({ explicitRunnableHandoff: true })).not.toThrow();
    });
    test('keeps untimed preparation separate from measured synchronous steps', () => {
        const stops = [62, 63, 65, 66, 71].map((line) => ({
            sourceSuffix: 'DemoDataService.cs',
            line,
            localNames: ['filter'],
        }));
        expect(
            parseDebuggerWorkload({ ...small, id: 'havit', stops, preparationTransitions: 2 }).preparationTransitions
        ).toBe(2);
        expect(() => parseDebuggerWorkload({ ...small, preparationTransitions: 2 })).toThrow();
    });
    test('supports a normal existing navigation anchor without an input value', () => {
        const entry = {
            selector: '.on-this-page-navigation a[href$="#header-filtering"]',
            action: 'click',
            expectedHrefSuffix: '#header-filtering',
        };
        expect(parseDebuggerWorkload({ ...small, entry, scenario: 'url-helper-primitive' }).entry?.action).toBe(
            'click'
        );
    });
    test('preserves the original input action and rejects ambiguous entry actions', () => {
        expect(parseDebuggerWorkload({ ...small, entry: { selector: 'input', text: 'John' } }).entry?.text).toBe(
            'John'
        );
        expect(() => parseDebuggerWorkload({ ...small, entry: { selector: 'input', action: 'click' } })).toThrow();
        expect(() => parseDebuggerWorkload({ ...small, entry: { selector: 'a', action: 'hover' } })).toThrow();
        expect(() => parseDebuggerWorkload({ ...small, entry: { selector: 'input' } })).toThrow();
    });
    test('records source-derived desktop anchor readiness without assuming observed DOM state', () => {
        const entry = {
            selector: '.on-this-page-navigation.side-page-navigation a[href$="#header-filtering"]',
            action: 'click',
            expectedHrefSuffix: '#header-filtering',
            expectedText: 'Filtering from headers',
            minimumViewportWidth: 992,
        };
        expect(parseDebuggerWorkload({ ...small, entry }).entry?.minimumViewportWidth).toBe(992);
        expect(() => parseDebuggerWorkload({ ...small, entry: { ...entry, minimumViewportWidth: -1 } })).toThrow();
        expect(() => parseDebuggerWorkload({ ...small, entry: { ...entry, expectedText: 12 } })).toThrow();
    });
    test('uses ordinary history only for existing anchor clicks', () => {
        const entry = {
            selector: 'a',
            action: 'click',
            expectedHrefSuffix: '#header-filtering',
            historyRoundTrip: true,
        };
        expect(parseDebuggerWorkload({ ...small, entry }).entry?.historyRoundTrip).toBe(true);
        expect(() =>
            parseDebuggerWorkload({ ...small, entry: { selector: 'input', text: 'John', historyRoundTrip: true } })
        ).toThrow();
    });
});
