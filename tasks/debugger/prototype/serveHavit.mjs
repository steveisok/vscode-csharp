/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const [moduleFile, directory, port] = process.argv.slice(2);
if (!moduleFile || !directory || !Number.isInteger(Number(port))) {
    throw Error('Usage: serveHavit.mjs <existing bench.mjs> <complete webroot> <port>');
}
const { startServer } = await import(pathToFileURL(path.resolve(moduleFile)).href);
if (typeof startServer !== 'function') throw Error('Configured Havit module does not export startServer.');
const server = await startServer(directory, Number(port));
console.log(`Owned debugger-only Havit server: ${server.url}`);
process.once('SIGINT', () => server.close());
process.once('SIGTERM', () => server.close());
