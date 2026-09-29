#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

import { runCli } from './cli.js';
import { runMcpStdio } from './mcp/server.js';
import { version } from './version.js';

async function readStdin(): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
}

// A reader that goes away early (daho api ... | head) is not an error worth a stack trace.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') {
        throw err;
    }
});

const code = await runCli(process.argv.slice(2), {
    env: process.env,
    stdout: (chunk) => void process.stdout.write(chunk),
    stderr: (text) => void process.stderr.write(text),
    readStdin,
    readFile: (path) => readFile(path),
    runMcp: (config) => runMcpStdio(config, version),
    version
});
// exitCode (not process.exit) so a large response finishes flushing to a pipe.
process.exitCode = code;
