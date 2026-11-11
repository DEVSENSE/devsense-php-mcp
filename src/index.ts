#! /usr/bin/env node

import { Option, program } from 'commander';
import { LanguageClient } from './client';
import { DefaultMcpServerPort, DefaultPhpVersion } from './consts';
import { Logger } from './logger';
import { HttpToStdio } from './HttpToStdio';
import { createServer } from 'node:net';

async function availablePort(): Promise<number> {
    const server = createServer();
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close();
                reject(new Error('Failed to allocate an MCP server port'));
                return;
            }
            server.close(error => error ? reject(error) : resolve(address.port));
        });
    });
}

async function main(argv: string[]) {

    await program
        .version(require('../package.json').version)
        .name('devsense-php-mcp')
        .description('PHP MCP Server')
        .showHelpAfterError(true)
        .option('-r, --root <path>', 'Root directory, to which are other parameters relative. Current working directory by default.')
        .option('-x, --exclude <path...>', 'Files or directories to be excluded from indexing.')
        .option('-p, --mcp-port <N>', 'Specify the MCP server port number.', str => parseInt(str), DefaultMcpServerPort)
        .addOption(new Option('-t, --transport <type>', 'Specify the transport type.').choices(['http', 'stdio']).default('http'))
        .argument('[path...]', 'Files or directories to be indexed.')
        .action(async (paths: string[] | undefined, options) => {

            //
            const log = new Logger(true)
            const root = options.root ?? process.cwd()

            const port = options.transport === 'stdio' && program.getOptionValueSource('mcpPort') === 'default'
                ? await availablePort()
                : options.mcpPort
            const client = new LanguageClient(log, port)

            const indexing = new Promise(resolve => {
                client.onLoadStatus(status => {
                    if (!status.isLoadPending && !status.pendingAnalysis && !status.pendingParse) {
                        resolve(true)
                    }
                })
            })

            try {
                await client.start(
                    root,
                    paths ?? ['**/*.php'],
                    options.exclude,
                    DefaultPhpVersion,
                )

                if (!client.MCPServerPort) {
                    throw new Error('Failed to start MCP Server')
                }

                if (options.transport === 'stdio') {
                    await HttpToStdio(client.MCPServerPort);
                }
            } catch (error) {
                try {
                    await client.exit()
                } catch (exitError) {
                    console.error('Failed to stop the PHP language server:', exitError)
                }
                throw error
            }

            if (options.transport === 'stdio') {
                await client.exit()
                return
            }

            log.info(`MCP Server running on 127.0.0.1:${client.MCPServerPort} ...`)

            //
            await indexing

            // await Ctrl+C to gracefully exit
            log.info(`Press Ctrl+C to exit.`)
            process.on('SIGINT', async () => {
                log.info('Received Ctrl+C, exiting...')
                await client.exit()
                process.exit(0)
            })
        })
        .parseAsync(argv)
}

//
main(process.argv).catch(error => {
    console.error(error)
    process.exitCode = 1
})