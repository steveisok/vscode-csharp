/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { HostPlatform, MachineConfig, sha256, SourceManifest } from './prototypeConfig';

export function bundlePrototypeProvenance(
    directory: string,
    configFile: string,
    config: MachineConfig,
    manifest: SourceManifest,
    host: HostPlatform,
    command: string[]
): void {
    if (!manifest.sources?.length) {
        throw new Error('Result bundles require source origins, refs, immutable base commits and local patch hashes.');
    }
    const provenance = path.join(directory, 'provenance');
    fs.mkdirSync(provenance);
    const copy = (source: string, name: string, expected = sha256(source)) => {
        if (sha256(source) !== expected) {
            throw new Error(`Changed provenance input: ${source}`);
        }
        const target = path.join(provenance, name);
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        if (sha256(target) !== expected) {
            throw new Error(`Provenance copy hash mismatch: ${name}`);
        }
        return { path: name, sha256: expected };
    };
    const sources = manifest.sources.map((source) => ({
        ...source,
        ...(source.localPatch
            ? { localPatch: copy(source.localPatch.path, `${source.id}.diff`, source.localPatch.sha256) }
            : {}),
    }));
    const artifactManifest = copy(config.manifest, 'artifact-cohort.original.json');
    const machineConfig = copy(configFile, 'machine.original.json');
    fs.writeFileSync(path.join(provenance, 'artifact-cohort.json'), JSON.stringify({ ...manifest, sources }, null, 2), {
        flag: 'wx',
    });
    fs.writeFileSync(path.join(provenance, 'machine.resolved.json'), JSON.stringify(config, null, 2), { flag: 'wx' });
    for (const selector of ['small', 'havit'] as const) {
        copy(
            config.paths[`${selector}Handoff`],
            `${selector}-handoff.json`,
            manifest.workloads[selector].handoffSha256
        );
    }
    fs.writeFileSync(
        path.join(provenance, 'launch.json'),
        JSON.stringify(
            { command, host, versions: manifest.versions, artifactManifest, machineConfig, sources },
            null,
            2
        ),
        { flag: 'wx' }
    );
}
