/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('fs');
const { runTests } = require('@vscode/test-electron');
if (process.argv.length !== 3) throw Error('launchTests requires an owned per-run test-launch.json path.');
runTests(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
