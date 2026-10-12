/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('fs');
const [port, output, expectedLine] = process.argv.slice(2);
const expectation = expectedLine?.startsWith('{')
    ? JSON.parse(expectedLine)
    : {
          line: expectedLine ? Number(expectedLine) : undefined,
          localNames: ['args'],
      };

async function main() {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find((target) => target.type === 'page' && target.url.includes('workbench'));
    if (!target) throw new Error('The owned VS Code workbench UI was not found.');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
            const request = pending.get(message.id);
            pending.delete(message.id);
            message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
        }
    });
    const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const id = ++sequence;
            pending.set(id, { resolve, reject });
            socket.send(JSON.stringify({ id, method, params }));
        });
    try {
        const snapshotParameters = {
            expression: `(() => {
                const panes = [...document.querySelectorAll('.pane')];
                const debugPanes = panes.filter(pane => /variables|call stack/i.test(pane.querySelector('.pane-header')?.textContent ?? ''));
                for (const pane of debugPanes) {
                    const header = pane.querySelector('.pane-header');
                    if (header?.getAttribute('aria-expanded') === 'false') header.click();
                }
                return {
                    title: document.title,
                    debugPanes: debugPanes.map(pane => ({
                        header: pane.querySelector('.pane-header')?.textContent,
                        expanded: pane.querySelector('.pane-header')?.getAttribute('aria-expanded'),
                        visible: pane.getBoundingClientRect().height > 0,
                        content: pane.querySelector('.pane-body')?.innerText
                    })),
                    sidebarText: document.querySelector('.sidebar')?.innerText
                };
            })()`,
            returnByValue: true,
        };
        let snapshot;
        const deadline = Date.now() + 5000;
        do {
            snapshot = await send('Runtime.evaluate', snapshotParameters);
            const panes = snapshot.result.value.debugPanes;
            const stack = panes.find((pane) => /call stack/i.test(pane.header));
            const variables = panes.find((pane) => /variables/i.test(pane.header));
            if (
                !expectation.line ||
                (stack?.content.includes(`Line ${expectation.line}`) &&
                    (!expectation.sourceSuffix ||
                        stack.content.includes(expectation.sourceSuffix.split(/[\\/]/).pop())) &&
                    expectation.localNames.every((name) => variables?.content.includes(name)) &&
                    Object.values(expectation.localValues ?? {}).every((value) => variables?.content.includes(value)))
            )
                break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        const renderedUiObservedAtEpochMs = Date.now();
        if (expectation.line) {
            const panes = snapshot.result.value.debugPanes;
            if (
                !panes.some(
                    (pane) =>
                        /call stack/i.test(pane.header) &&
                        pane.content.includes(`Line ${expectation.line}`) &&
                        (!expectation.sourceSuffix ||
                            pane.content.includes(expectation.sourceSuffix.split(/[\\/]/).pop()))
                ) ||
                !panes.some(
                    (pane) =>
                        /variables/i.test(pane.header) &&
                        expectation.localNames.every((name) => pane.content.includes(name)) &&
                        Object.values(expectation.localValues ?? {}).every((value) => pane.content.includes(value))
                )
            ) {
                throw new Error(
                    `The rendered call stack and baseline locals did not refresh to line ${expectation.line}.`
                );
            }
        }
        const tree = await send('Accessibility.getFullAXTree');
        fs.writeFileSync(
            `${output}.json`,
            JSON.stringify(
                {
                    renderedUiObservedAtEpochMs,
                    expectedLine,
                    workbench: snapshot.result.value,
                    accessibility: tree.nodes.filter((n) =>
                        /variables|call stack|paused|not implemented|step over|thread #1/i.test(n.name?.value ?? '')
                    ),
                },
                null,
                2
            )
        );
        const image = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        fs.writeFileSync(`${output}.png`, Buffer.from(image.data, 'base64'));
        console.log(`OWNED UI CAPTURE ${JSON.stringify(snapshot.result.value)}`);
        if (
            snapshot.result.value.debugPanes.length < 2 ||
            snapshot.result.value.debugPanes.some((pane) => !pane.visible)
        ) {
            throw new Error('The actual Call Stack and Variables panes were not both visible.');
        }
    } finally {
        socket.close();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
