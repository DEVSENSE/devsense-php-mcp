# DEVSENSE PHP MCP Server

Standalone MCP server built on `devsense-php-ls`, the DEVSENSE PHP Language Server.

## Configure MCP client using stdio

Configure your MCP client to launch the command with `--transport=stdio`. For example, in a client that uses an `mcpServers` configuration:

```json
{
  "mcpServers": {
    "php": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "devsense-php-mcp", "--transport=stdio", "--root", "path/to/php-project"]
    }
  }
}
```

Replace the root path with your PHP workspace; absolute or relative to current working directory. Configuration format and command resolution vary by client.

The client starts and stops the server. Standard output is reserved for MCP messages; diagnostics are written to standard error. The language server still runs a local HTTP server internally; stdio mode selects an available localhost port by default. Use `--mcp-port` to choose a specific port when necessary.

## Run the HTTP server

HTTP is the default transport:

```sh
devsense-php-mcp --mcp-port 9101 --root .
```

The language server listens on `127.0.0.1:9101` by default. Press Ctrl+C to stop it. Its HTTP endpoint accepts JSON-RPC POST requests; it is not an MCP Streamable HTTP endpoint.

## Options

Run `devsense-php-mcp --help` for all options. Common options:

| Option | Description |
| --- | --- |
| `-t, --transport <type>` | `http` (default) or `stdio`. |
| `-r, --root <path>` | PHP workspace root; defaults to the current directory. |
| `-p, --mcp-port <N>` | Local language-server MCP port; defaults to `9101` for HTTP and an available port for stdio. |
| `-x, --exclude <path...>` | Files or directories to exclude from indexing. |

## More details

- [MCP tools list](https://docs.devsense.com/other/mcp/mcptools-list/)
- [PHP MCP server overview](https://docs.devsense.com/other/mcp/)
