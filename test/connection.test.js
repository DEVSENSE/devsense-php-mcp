const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const path = require('node:path');
const readline = require('node:readline');
const test = require('node:test');
const { ListToolsResultSchema, CallToolResultSchema } = require('@modelcontextprotocol/sdk/types.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const cli = path.resolve(__dirname, '..', 'dist', 'index.js');
const root = path.join(__dirname, 'data');

test('stdio connects, lists tools, and exits when stdin closes', { timeout: 60000 }, async t => {
    const child = spawn(process.execPath, [cli, '--transport=stdio', '--root', root], {
        stdio: ['pipe', 'pipe', 'pipe']
    });
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.stdin.end();
            await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
            if (child.exitCode === null && child.signalCode === null) child.kill();
        }
    });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    child.stdin.on('error', () => {});
    const exited = once(child, 'exit');
    const lines = readline.createInterface({ input: child.stdout });
    const responses = new Map();
    let failure;
    lines.on('line', line => {
        try {
            const message = JSON.parse(line);
            const response = responses.get(message.id);
            if (response) {
                responses.delete(message.id);
                response.resolve(message);
            }
        } catch (error) {
            failure = error;
            for (const response of responses.values()) response.reject(error);
            responses.clear();
        }
    });
    child.on('exit', (code, signal) => {
        for (const response of responses.values()) {
            response.reject(new Error(`CLI exited (${code ?? signal}): ${stderr}`));
        }
        responses.clear();
    });
    function request(id, method, params) {
        if (failure) return Promise.reject(failure);
        const result = new Promise((resolve, reject) => responses.set(id, { resolve, reject }));
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        return result;
    }

    const initialized = await request(1, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'connection-test', version: '1.0.0' }
    });
    assert.equal(initialized.result?.serverInfo?.name, 'devsense-php-mcp', JSON.stringify(initialized));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = await request(2, 'tools/list', {});
    ListToolsResultSchema.parse(tools.result);
    assert.ok(tools.result.tools.length > 0);

    const called = await request(3, 'tools/call', { name: 'search-symbol', arguments: { q: 'unknown_symbol' } });
    const result = CallToolResultSchema.parse(called.result);
    assert.ok(result.content.some(item => item.type === 'text' && Array.isArray(JSON.parse(item.text))));

    const missing = await request(4, 'tools/call', { name: 'not_a_tool', arguments: {} });
    assert.equal(missing.error?.code, 404, JSON.stringify(missing));

    const sdkClient = new Client({ name: 'connection-test', version: '1.0.0' });
    const sdkTransport = new StdioClientTransport({
        command: process.execPath,
        args: [cli, '--transport=stdio', '--root', root],
        stderr: 'pipe'
    });
    sdkTransport.stderr.resume();
    t.after(() => sdkClient.close());
    await sdkClient.connect(sdkTransport);
    assert.ok((await sdkClient.listTools()).tools.length > 0);
    const sdkResult = await sdkClient.callTool({ name: 'search-symbol', arguments: { q: 'unknown_symbol' } });
    assert.ok(sdkResult.content.some(item => item.type === 'text'));
    await sdkClient.close();

    child.stdin.end();
    const [code, signal] = await exited;
    assert.equal(failure, undefined);
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, stderr);
});

test('rejects unsupported transports', () => {
    const result = spawnSync(process.execPath, [cli, '--transport=invalid'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid/i);
});

test('default transport serves HTTP on the requested port', { timeout: 60000 }, async t => {
    const reservation = net.createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));

    // IPC lets the test request a graceful SIGINT on Windows as well as Unix.
    const wrapper = "process.argv = [process.execPath, process.argv[1], '--mcp-port', process.argv[2], '--root', process.argv[3]]; process.on('message', () => process.emit('SIGINT')); require(process.argv[1]);";
    const child = spawn(process.execPath, ['-e', wrapper, cli, String(port), root], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    child.stdout.resume();
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const exited = once(child, 'exit');
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            if (child.connected) child.send('stop');
            await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
            if (child.exitCode === null && child.signalCode === null) child.kill();
        }
    });
    const lines = readline.createInterface({ input: child.stderr });
    await Promise.race([
        (async () => {
            for await (const line of lines) {
                if (line.includes('Press Ctrl+C')) return;
            }
            throw new Error(`CLI stopped before HTTP was ready: ${stderr}`);
        })(),
        exited.then(([code, signal]) => { throw new Error(`CLI exited (${code ?? signal}): ${stderr}`); })
    ]);

    const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } }
        })
    });
    assert.equal(response.status, 200);
    assert.ok((await response.json()).result.capabilities.tools);
    child.send('stop');
    const [code, signal] = await exited;
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, stderr);
});
