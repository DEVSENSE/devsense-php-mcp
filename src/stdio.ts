import http from 'http';

export interface StdioForwarderOptions {
    port?: number;
    host?: string;
    onClose?: () => void;
    localHandler?: (rawJson: string) => string | undefined;
}

export interface McpToolSchema {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

export const DefaultMcpTools: McpToolSchema[] = [
    {
        name: 'find-occurences',
        description: 'Finds all occurrences of a symbol in the workspace. Use it for semantic symbol search across the workspace. This tool understands PHP semantics, infers types to provide better results, and looks semantically into documentary comments and string literals.',
        inputSchema: {
            type: 'object',
            properties: {
                kind: {
                    description: 'The kind of symbol to find occurrences for.',
                    enum: ['class', 'function', 'variable', 'constant'],
                },
                symbolFqn: {
                    description: 'The symbol name to find occurrences for. This must be a valid fully qualified identifier (in case of class or function, it must contain full namespaced name).',
                },
            },
            required: ['symbolFqn', 'kind'],
        },
    },
    {
        name: 'search-symbol',
        description: 'Searches for symbols (classes, methods, fields). Use this tool for lookup by identifier fragments.\r\nResults include match coordinates when available (0-based line/column)',
        inputSchema: {
            type: 'object',
            properties: {
                limit: {
                    description: 'The maximum number of results to return. Default is 100.',
                    pattern: '^-?(?:0|[1-9]\\d*)$',
                    type: ['string', 'integer'],
                },
                q: {
                    description: 'The search query. Can be a short name, a fully qualified name, or a fragment of a name.',
                },
            },
            required: ['q'],
        },
    },
    {
        name: 'analyze-calls',
        description: 'Builds the IDE Call Hierarchy tree for a method, function, or constructor.\r\nUse it to see who calls a symbol ("direction": "incoming") or what the symbol calls ("direction": "outgoing").\r\n\r\nPrefer this tool over usage search, text search, or regex search when evaluating dependencies by actual calls.\r\nIt uses IDE call hierarchy data, so it provides more precise call relationships with less noise and fewer follow-up calls than primitive searches.\r\n\r\nPass "symbolFqn" as a fully qualified name, for example "\\\\strlen".\r\nIf you only know a short name or fragment, use `search-symbol` first to find the target.\r\n\r\nThe result is a tree structured object. Each node includes "uri" and "symbolFqn".\r\nPass "symbolFqn" back to render the subtree.\r\nSymbols can come from workspace, included PHAR files, built-in PHP manual, or required Composer packages.',
        inputSchema: {
            type: 'object',
            properties: {
                depth: {
                    description: 'The depth of the call analysis.',
                    pattern: '^-?(?:0|[1-9]\\d*)$',
                    type: ['string', 'integer'],
                },
                direction: {
                    description: 'The direction of the call analysis.',
                },
                symbolFqn: {
                    description: 'Plain fully qualified function name. If you only know a short name or fragment, use `search-symbol` first and pass the best fully qualified callable name here. Do not pass a file path, line, column, or call signature.',
                },
                uri: {
                    description: 'The current file URI used as a hint in case of ambiguity.',
                },
            },
            required: ['symbolFqn', 'direction'],
        },
    },
    {
        name: 'get-composer-dependencies',
        description: 'Returns Composer packages installed in the project and their exact versions.\r\nReads from the already-indexed composer.lock data.\r\n\r\nUse this to determine which libraries and versions are available before generating code.',
        inputSchema: {
            type: 'object',
            properties: {
                nameFilter: {
                    description: 'Optional filter for package names, case-insensitive. Can contain wildcard characters (e.g. "phpunit/*", "symfony/console").',
                },
            },
        },
    },
    {
        name: 'php-version',
        description: 'Returns the PHP version of the current workspace.',
        inputSchema: {
            type: 'object',
        },
    },
];

export function createDiagnosticHandler(diagnosticMessage: string, serverVersion: string): (rawJson: string) => string | undefined {
    const handleSingle = (msg: unknown): Record<string, unknown> | undefined => {
        if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
            return {
                jsonrpc: '2.0',
                id: null,
                error: { code: -32600, message: 'Invalid Request' },
            };
        }

        const obj = msg as Record<string, unknown>;
        const method = typeof obj.method === 'string' ? obj.method : undefined;
        const hasId = 'id' in obj;
        const id = hasId ? obj.id : undefined;

        // Notifications (no id) do not receive a JSON-RPC response
        if (!hasId) {
            return undefined;
        }

        if (method === 'initialize') {
            const params = (typeof obj.params === 'object' && obj.params !== null ? obj.params : {}) as Record<string, unknown>;
            const protocolVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05';
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion,
                    capabilities: {
                        tools: {},
                    },
                    serverInfo: {
                        name: 'devsense-php-mcp',
                        version: serverVersion,
                    },
                    instructions: diagnosticMessage,
                },
            };
        }

        if (method === 'ping') {
            return {
                jsonrpc: '2.0',
                id,
                result: {},
            };
        }

        if (method === 'tools/list') {
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    tools: DefaultMcpTools,
                },
            };
        }

        if (method === 'tools/call') {
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    content: [
                        {
                            type: 'text',
                            text: diagnosticMessage,
                        },
                    ],
                    isError: true,
                },
            };
        }

        if (method === 'resources/list') {
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    resources: [],
                },
            };
        }

        if (method === 'resources/templates/list') {
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    resourceTemplates: [],
                },
            };
        }

        if (method === 'prompts/list') {
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    prompts: [],
                },
            };
        }

        return {
            jsonrpc: '2.0',
            id,
            error: {
                code: -32601,
                message: `Method not found: ${method ?? 'unknown'}. ${diagnosticMessage}`,
            },
        };
    };

    return (rawJson: string): string | undefined => {
        try {
            const parsed: unknown = JSON.parse(rawJson);
            if (Array.isArray(parsed)) {
                const responses = parsed
                    .map(item => handleSingle(item))
                    .filter((res): res is Record<string, unknown> => res !== undefined);
                return responses.length > 0 ? JSON.stringify(responses) : undefined;
            }
            const response = handleSingle(parsed);
            return response !== undefined ? JSON.stringify(response) : undefined;
        } catch {
            return JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32700, message: 'Parse error' },
            });
        }
    };
}

interface NormalizedMessage {
    payload: string;
    isNotification: boolean;
    id: unknown;
}

export class StdioForwarder {
    private readonly host: string;
    private port?: number;
    private buffer: Buffer = Buffer.alloc(0);
    private isFramed: boolean | null = null;
    private readonly queue: string[] = [];
    private flushing = false;
    private stdinEnded = false;
    private closed = false;
    private readonly onClose?: () => void;
    private readonly localHandler?: (rawJson: string) => string | undefined;

    constructor(options: StdioForwarderOptions = {}) {
        this.host = options.host ?? '127.0.0.1';
        this.port = options.port;
        this.onClose = options.onClose;
        this.localHandler = options.localHandler;
    }

    public setPort(port: number): void {
        this.port = port;
        void this.flushQueue();
    }

    public start(): void {
        process.stdin.on('data', (chunk: Buffer) => this.handleData(chunk));
        process.stdin.on('end', () => this.handleStdinEnd());
        process.stdin.on('close', () => this.handleStdinEnd());
        process.stdin.resume();
    }

    private handleStdinEnd(): void {
        this.stdinEnded = true;
        this.checkClose();
    }

    private checkClose(): void {
        if (this.closed || !this.stdinEnded) {
            return;
        }
        if (this.flushing || this.queue.length > 0) {
            return;
        }
        this.closed = true;
        this.onClose?.();
    }

    private handleData(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.processBuffer();
    }

    private processBuffer(): void {
        while (this.buffer.length > 0) {
            // Skip leading whitespace / newlines between messages
            let start = 0;
            while (
                start < this.buffer.length &&
                (this.buffer[start] === 32 ||
                    this.buffer[start] === 9 ||
                    this.buffer[start] === 10 ||
                    this.buffer[start] === 13)
            ) {
                start++;
            }
            if (start > 0) {
                this.buffer = this.buffer.subarray(start);
                if (this.buffer.length === 0) break;
            }

            // Detect message framing: Content-Length header or newline-delimited JSON
            if (this.buffer[0] === 123 || this.buffer[0] === 91) { // '{' or '[' character
                const newlineIndex = this.buffer.indexOf(10); // '\n'
                if (newlineIndex !== -1) {
                    const lineBuf = this.buffer.subarray(0, newlineIndex);
                    this.buffer = this.buffer.subarray(newlineIndex + 1);
                    const line = lineBuf.toString('utf8').trim();
                    if (line) {
                        this.isFramed = false;
                        this.enqueueMessage(line);
                    }
                    continue;
                }
                // Incomplete line, wait for more data
                break;
            } else {
                // Header-delimited framing (Content-Length: ... \r\n\r\n <payload>)
                const headerEnd = this.buffer.indexOf('\r\n\r\n');
                if (headerEnd !== -1) {
                    const headerStr = this.buffer.subarray(0, headerEnd).toString('utf8');
                    const match = headerStr.match(/Content-Length:\s*(\d+)/i);
                    if (match) {
                        const contentLength = parseInt(match[1], 10);
                        const headerByteLength = headerEnd + 4;
                        if (this.buffer.length >= headerByteLength + contentLength) {
                            const bodyBuf = this.buffer.subarray(headerByteLength, headerByteLength + contentLength);
                            this.buffer = this.buffer.subarray(headerByteLength + contentLength);
                            this.isFramed = true;
                            this.enqueueMessage(bodyBuf.toString('utf8'));
                            continue;
                        } else {
                            // Incomplete body, wait for more data
                            break;
                        }
                    } else {
                        // Unrecognized header, drop up to headerEnd + 4
                        this.buffer = this.buffer.subarray(headerEnd + 4);
                        continue;
                    }
                }
                // Incomplete header, wait for more data
                break;
            }
        }
    }

    private enqueueMessage(rawJson: string): void {
        this.queue.push(rawJson);
        void this.flushQueue();
    }

    private async flushQueue(): Promise<void> {
        if (this.flushing || (this.port === undefined && !this.localHandler)) {
            return;
        }
        this.flushing = true;
        try {
            while (this.queue.length > 0 && (this.port !== undefined || this.localHandler)) {
                const next = this.queue.shift()!;
                if (this.localHandler) {
                    const response = this.localHandler(next);
                    if (response !== undefined) {
                        this.sendStdout(response);
                    }
                } else if (this.port !== undefined) {
                    await this.forwardMessage(next, this.port);
                }
            }
        } finally {
            this.flushing = false;
            this.checkClose();
        }
    }

    private normalizeMessage(rawJson: string): NormalizedMessage {
        try {
            const parsed: unknown = JSON.parse(rawJson);
            if (Array.isArray(parsed)) {
                let modified = false;
                for (const item of parsed) {
                    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
                        const obj = item as Record<string, unknown>;
                        if (typeof obj.method === 'string' && (obj.params === undefined || obj.params === null)) {
                            obj.params = {};
                            modified = true;
                        }
                    }
                }
                const allNotifications =
                    parsed.length > 0 &&
                    parsed.every(
                        (item) =>
                            typeof item === 'object' &&
                            item !== null &&
                            !Array.isArray(item) &&
                            typeof (item as Record<string, unknown>).method === 'string' &&
                            !('id' in item)
                    );
                return {
                    payload: modified ? JSON.stringify(parsed) : rawJson,
                    isNotification: allNotifications,
                    id: undefined,
                };
            }

            if (typeof parsed === 'object' && parsed !== null) {
                const obj = parsed as Record<string, unknown>;
                const isRequestOrNotification = typeof obj.method === 'string';
                const hasId = 'id' in obj;
                const isNotification = isRequestOrNotification && !hasId;
                const id = hasId ? obj.id : undefined;

                if (isRequestOrNotification && (obj.params === undefined || obj.params === null)) {
                    obj.params = {};
                    return {
                        payload: JSON.stringify(obj),
                        isNotification,
                        id,
                    };
                }

                return {
                    payload: rawJson,
                    isNotification,
                    id,
                };
            }
        } catch {
            // Fall through and forward raw payload as-is
        }

        return {
            payload: rawJson,
            isNotification: false,
            id: undefined,
        };
    }

    private forwardMessage(rawJson: string, port: number): Promise<void> {
        const { payload, isNotification, id } = this.normalizeMessage(rawJson);
        const postData = Buffer.from(payload, 'utf8');

        return new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
                if (!settled) {
                    settled = true;
                    resolve();
                }
            };

            const req = http.request(
                {
                    hostname: this.host,
                    port,
                    path: '/',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': postData.length,
                    },
                },
                (res) => {
                    let body = '';
                    res.setEncoding('utf8');
                    res.on('data', (chunk) => {
                        body += chunk;
                    });
                    res.on('end', () => {
                        if (!isNotification && body && body.trim().length > 0) {
                            this.sendStdout(body.trim());
                        }
                        finish();
                    });
                    res.on('error', (err) => {
                        process.stderr.write(`[devsense-php-mcp] Response error: ${err.message}\n`);
                        if (!isNotification && id !== undefined) {
                            this.sendStdout(
                                JSON.stringify({
                                    jsonrpc: '2.0',
                                    id,
                                    error: { code: -32603, message: err.message },
                                })
                            );
                        }
                        finish();
                    });
                }
            );

            req.on('error', (err) => {
                process.stderr.write(`[devsense-php-mcp] Forwarding error: ${err.message}\n`);
                if (!isNotification && id !== undefined) {
                    this.sendStdout(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            id,
                            error: { code: -32603, message: err.message },
                        })
                    );
                }
                finish();
            });

            req.write(postData);
            req.end();
        });
    }

    private sendStdout(responseJson: string): void {
        if (this.isFramed) {
            const bodyBuf = Buffer.from(responseJson, 'utf8');
            process.stdout.write(`Content-Length: ${bodyBuf.length}\r\n\r\n${responseJson}`);
        } else {
            let singleLine = responseJson;
            if (singleLine.includes('\n') || singleLine.includes('\r')) {
                try {
                    singleLine = JSON.stringify(JSON.parse(singleLine));
                } catch {
                    singleLine = singleLine.replace(/[\r\n]+/g, ' ');
                }
            }
            process.stdout.write(`${singleLine}\n`);
        }
    }
}


