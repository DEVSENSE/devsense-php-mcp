import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    CallToolResultSchema,
    GetPromptRequestSchema,
    GetPromptResultSchema,
    JSONRPCResponseSchema,
    ListPromptsRequestSchema,
    ListPromptsResultSchema,
    ListResourcesRequestSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesRequestSchema,
    ListResourceTemplatesResultSchema,
    ListToolsRequestSchema,
    ListToolsResultSchema,
    McpError,
    ReadResourceRequestSchema,
    ReadResourceResultSchema,
    ServerCapabilitiesSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * The language server's HTTP endpoint accepts JSON-RPC POSTs but does not
 * implement the MCP Streamable HTTP transport.
 */
export async function HttpToStdio(port: number): Promise<void> {
    const url = `http://127.0.0.1:${port}/`;
    let nextId = 0;

    async function request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
        const id = ++nextId;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }),
            signal,
        });
        if (!response.ok) {
            throw new Error(`MCP HTTP request failed: ${response.status} ${response.statusText}`);
        }
        const message = JSONRPCResponseSchema.parse(await response.json());
        if (message.id !== id) {
            throw new Error('MCP HTTP response has an unexpected request ID');
        }
        if ('error' in message) {
            throw new McpError(message.error.code, message.error.message, message.error.data);
        }
        return message.result;
    }

    const initialization = await request('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'devsense-php-mcp-stdio-bridge', version: '1.0.0' },
    });
    if (!initialization || typeof initialization !== 'object' || !('capabilities' in initialization)) {
        throw new Error('MCP HTTP initialize response is missing capabilities');
    }
    const upstreamCapabilities = ServerCapabilitiesSchema.parse(initialization.capabilities);
    const capabilities = {
        ...(upstreamCapabilities.tools ? { tools: {} } : {}),
        ...(upstreamCapabilities.resources ? { resources: {} } : {}),
        ...(upstreamCapabilities.prompts ? { prompts: {} } : {}),
    };
    const server = new Server(
        { name: 'devsense-php-mcp', version: require('../package.json').version },
        { capabilities },
    );

    if (upstreamCapabilities.tools) {
        server.setRequestHandler(ListToolsRequestSchema, async (message, extra) => {
            const result = await request(message.method, message.params, extra.signal);
            if (result && typeof result === 'object' && 'tools' in result && Array.isArray(result.tools)) {
                // MCP output schemas must describe objects; the language server also returns array schemas.
                const tools = result.tools.map(tool => {
                    if (tool && typeof tool === 'object' && tool.outputSchema?.type === 'array') {
                        const { outputSchema, ...rest } = tool;
                        return rest;
                    }
                    return tool;
                });
                return ListToolsResultSchema.parse({ ...result, tools });
            }
            return ListToolsResultSchema.parse(result);
        });
        server.setRequestHandler(CallToolRequestSchema, async (message, extra) => {
            const result = await request(message.method, message.params, extra.signal);
            if (result && typeof result === 'object' && 'structuredContent' in result && Array.isArray(result.structuredContent)) {
                const { structuredContent, ...rest } = result;
                if (!('content' in rest) || !Array.isArray(rest.content)) {
                    return CallToolResultSchema.parse(result);
                }
                return CallToolResultSchema.parse({
                    ...rest,
                    content: [...rest.content, { type: 'text', text: JSON.stringify(structuredContent) }],
                });
            }
            return CallToolResultSchema.parse(result);
        });
    }
    if (upstreamCapabilities.resources) {
        server.setRequestHandler(ListResourcesRequestSchema, async (message, extra) =>
            ListResourcesResultSchema.parse(await request(message.method, message.params, extra.signal)));
        server.setRequestHandler(ListResourceTemplatesRequestSchema, async (message, extra) =>
            ListResourceTemplatesResultSchema.parse(await request(message.method, message.params, extra.signal)));
        server.setRequestHandler(ReadResourceRequestSchema, async (message, extra) =>
            ReadResourceResultSchema.parse(await request(message.method, message.params, extra.signal)));
    }
    if (upstreamCapabilities.prompts) {
        server.setRequestHandler(ListPromptsRequestSchema, async (message, extra) =>
            ListPromptsResultSchema.parse(await request(message.method, message.params, extra.signal)));
        server.setRequestHandler(GetPromptRequestSchema, async (message, extra) =>
            GetPromptResultSchema.parse(await request(message.method, message.params, extra.signal)));
    }

    const transport = new StdioServerTransport();
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const closed = new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
    });
    process.stdin.once('end', finish);
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    transport.onclose = finish;
    transport.onerror = fail;

    try {
        await server.connect(transport);
        await closed;
    } finally {
        process.stdin.off('end', finish);
        process.off('SIGINT', finish);
        process.off('SIGTERM', finish);
        await server.close();
    }
}
