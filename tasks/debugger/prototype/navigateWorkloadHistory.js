/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('fs');
const [ownedBrowserWs, baseUrl, fragmentUrl, evidenceFile] = process.argv.slice(2);

async function main() {
    const endpoint = new URL(ownedBrowserWs);
    if (
        endpoint.protocol !== 'ws:' ||
        endpoint.hostname !== '127.0.0.1' ||
        !endpoint.pathname.startsWith('/devtools/browser/')
    ) {
        throw Error('A captured fresh owned browser address is required.');
    }
    const evidence = { baseUrl, fragmentUrl, operations: [], untimedSetupOnly: true };
    const save = () => fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
    let socket;
    try {
        const targetDeadline = Date.now() + 5000;
        let target;
        while (Date.now() < targetDeadline) {
            const targets = await (
                await fetch(`http://127.0.0.1:${endpoint.port}/json/list`, { signal: AbortSignal.timeout(1000) })
            ).json();
            target = targets.find((t) => t.type === 'page' && t.url === fragmentUrl);
            if (target) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (!target) throw Error('The real clicked fragment page was not observed in the owned browser.');
        const pageWs = new URL(target.webSocketDebuggerUrl);
        if (pageWs.hostname !== '127.0.0.1' || pageWs.port !== endpoint.port) {
            throw Error('Unexpected page endpoint outside the captured owned browser.');
        }
        socket = new WebSocket(pageWs.href);
        await new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true });
            socket.addEventListener('error', reject, { once: true });
        });
        let sequence = 0;
        const pending = new Map();
        socket.addEventListener('message', (event) => {
            const reply = JSON.parse(event.data);
            const request = pending.get(reply.id);
            if (!request) return;
            pending.delete(reply.id);
            clearTimeout(request.timer);
            reply.error ? request.reject(Error(JSON.stringify(reply.error))) : request.resolve(reply.result);
        });
        const send = (method, params = {}) =>
            new Promise((resolve, reject) => {
                const id = ++sequence;
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(Error(`${method} response timed out`));
                }, 5000);
                pending.set(id, { resolve, reject, timer });
                socket.send(JSON.stringify({ id, method, params }));
            });
        const history = await send('Page.getNavigationHistory');
        const current = history.entries[history.currentIndex];
        const previous = history.entries[history.currentIndex - 1];
        if (current?.url !== fragmentUrl || previous?.url !== baseUrl) {
            throw Error(`The real clicked Back/Forward entries are not as expected: ${JSON.stringify(history)}`);
        }
        evidence.clickedHistory = history;
        save();
        async function go(entry, action) {
            const operation = { action, entryId: entry.id, expectedUrl: entry.url, issuedAtEpochMs: Date.now() };
            evidence.operations.push(operation);
            save();
            await send('Page.navigateToHistoryEntry', { entryId: entry.id });
            operation.acknowledgedAtEpochMs = Date.now();
            const deadline = Date.now() + 5000;
            let stableSince;
            while (Date.now() < deadline) {
                const h = await send('Page.getNavigationHistory');
                const active = h.entries[h.currentIndex];
                if (active?.id === entry.id && active.url === entry.url) {
                    operation.observedUrl = active.url;
                    operation.observedAtEpochMs ??= Date.now();
                    stableSince ??= Date.now();
                    if (action === 'Forward' || Date.now() - stableSince >= 300) {
                        operation.stableHistoryObservedAtEpochMs = Date.now();
                        operation.historyQuiescenceMs = action === 'Back' ? 300 : 0;
                        save();
                        return;
                    }
                } else stableSince = undefined;
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            throw Error(`Ordinary browser ${action} did not reach the existing history entry.`);
        }
        await go(previous, 'Back');
        await go(current, 'Forward');
        evidence.historyRoundTripObserved = true;
        save();
        console.log(JSON.stringify(evidence));
    } catch (error) {
        evidence.failure = String(error);
        save();
        throw error;
    } finally {
        socket?.close();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
