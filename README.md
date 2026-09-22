# ERPNext MCP Server

A Model Context Protocol server for ERPNext integration

This is a TypeScript-based MCP server that provides integration with ERPNext/Frappe API. It enables AI assistants to interact with ERPNext data and functionality through the Model Context Protocol.

## Features

### Resources
- Access ERPNext documents via `erpnext://{doctype}/{name}` URIs
- JSON format for structured data access

### Tools
- `get_doctypes` - Get a list of all available DocTypes
- `get_doctype_fields` - Get fields list for a specific DocType
- `get_documents` - Get a list of documents for a specific doctype
- `get_document` - Get a single document by name, including all child tables
- `create_document` - Create a new document in ERPNext
- `update_document` - Update an existing document in ERPNext
- `delete_document` - Permanently delete a document
- `submit_document` - Submit a document (set docstatus to 1)
- `cancel_document` - Cancel a submitted document (set docstatus to 2)
- `call_method` - Call an ERPNext/Frappe whitelisted server-side API method
- `run_report` - Run an ERPNext report

## Configuration

The server requires the following environment variables:
- `ERPNEXT_URL` - The base URL of your ERPNext instance
- `ERPNEXT_API_KEY` (optional) - API key for authentication
- `ERPNEXT_API_SECRET` (optional) - API secret for authentication
- `ERPNEXT_ACCESS_TOKEN` (optional) - OAuth Bearer token; takes precedence over API key/secret
- `ERPNEXT_TIMEOUT_MS` (optional) - HTTP timeout in milliseconds; defaults to `15000`
- `ERPNEXT_ALLOWED_METHODS` (optional) - Comma-separated allowlist for `call_method`

Use either `ERPNEXT_ACCESS_TOKEN` or the `ERPNEXT_API_KEY`/`ERPNEXT_API_SECRET`
pair. Do not commit credentials to the repository.

## Development

Install dependencies:
```bash
npm install
```

Build the server:
```bash
npm run build
```

For development with auto-rebuild:
```bash
npm run watch
```

## Installation

To use with Claude Desktop, add the server config:

On MacOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
On Windows: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "erpnext": {
      "command": "node",
      "args": ["/path/to/erpnext-server/build/index.js"],
      "env": {
        "ERPNEXT_URL": "http://your-erpnext-instance.com",
        "ERPNEXT_API_KEY": "your-api-key",
        "ERPNEXT_API_SECRET": "your-api-secret"
      }
    }
  }
}
```

To use with Claude in VSCode, add the server config to:

On MacOS: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
On Windows: `%APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`

### Debugging

Since MCP servers communicate over stdio, debugging can be challenging. We recommend using the [MCP Inspector](https://github.com/modelcontextprotocol/inspector), which is available as a package script:

```bash
npm run inspector
```

The Inspector will provide a URL to access debugging tools in your browser.

## Usage Examples

### Get Customer List
```
<use_mcp_tool>
<server_name>erpnext</server_name>
<tool_name>get_documents</tool_name>
<arguments>
{
  "doctype": "Customer"
}
</arguments>
</use_mcp_tool>
```

### List documents with filters

`get_documents` accepts Frappe's canonical filter tuples and pagination options:

```json
{
  "doctype": "Customer",
  "fields": ["name", "customer_name", "territory"],
  "filters": [["disabled", "=", 0]],
  "limit": 25,
  "limit_start": 0,
  "order_by": "modified desc"
}
```

Simple `{ "field": "value" }` filters remain accepted for compatibility and
are normalized to equality filters.

`get_doctype_fields` uses Frappe's metadata endpoint when available, so it can
return fields even when the DocType has no documents. It falls back to the
legacy `DocType` resource endpoint for older Frappe installations.

The destructive tools (`cancel_document` and `delete_document`) are annotated
for MCP clients, but authorization must still be enforced by ERPNext. The
generic `call_method` tool should only be exposed to trusted clients because
it can invoke any whitelisted Frappe method.

Set `ERPNEXT_ALLOWED_METHODS` in production when `call_method` is enabled, for
example `frappe.auth.get_logged_user,frappe.client.get_count`.

### Get Customer Details
```
<access_mcp_resource>
<server_name>erpnext</server_name>
<uri>erpnext://Customer/CUSTOMER001</uri>
</access_mcp_resource>
```

### Create New Item
```
<use_mcp_tool>
<server_name>erpnext</server_name>
<tool_name>create_document</tool_name>
<arguments>
{
  "doctype": "Item",
  "data": {
    "item_code": "ITEM001",
    "item_name": "Test Item",
    "item_group": "Products",
    "stock_uom": "Nos"
  }
}
</arguments>
</use_mcp_tool>
```

### Get Item Fields
```
<use_mcp_tool>
<server_name>erpnext</server_name>
<tool_name>get_doctype_fields</tool_name>
<arguments>
{
  "doctype": "Item"
}
</arguments>
</use_mcp_tool>
