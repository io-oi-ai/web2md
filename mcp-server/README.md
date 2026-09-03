# web2md-mcp-server

MCP Server for [Web2MD](https://web2md.org) — convert webpage URLs to clean Markdown from Claude Desktop, Cursor, or any MCP-compatible AI agent.

## Install

```bash
npm install -g web2md-mcp-server
```

Or use directly with npx:

```bash
npx web2md-mcp-server
```

## Setup

### 1. Get an API key

Sign up at [web2md.org](https://web2md.org) and get your API key from the dashboard.

### 2. Configure Claude Desktop

Add to your Claude Desktop config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "web2md": {
      "command": "npx",
      "args": ["web2md-mcp-server"],
      "env": {
        "WEB2MD_API_KEY": "w2m_your_api_key"
      }
    }
  }
}
```

### 3. Configure Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "web2md": {
      "command": "npx",
      "args": ["web2md-mcp-server"],
      "env": {
        "WEB2MD_API_KEY": "w2m_your_api_key"
      }
    }
  }
}
```

## Windows Notes

### npx not working?

If `npx web2md-mcp-server` fails on Windows with "not recognized", use `node` directly:

1. Install globally: `npm install -g web2md-mcp-server`
2. Find the install path: `npm root -g`
3. Use this config instead:

```json
{
  "mcpServers": {
    "web2md": {
      "command": "node",
      "args": ["C:\\Users\\<user>\\AppData\\Roaming\\npm\\node_modules\\web2md-mcp-server\\dist\\index.js"],
      "env": {
        "WEB2MD_API_KEY": "w2m_your_api_key"
      }
    }
  }
}
```

Replace `<user>` with your Windows username, or run `npm root -g` to find the exact path.

### Claude Desktop: use the standard installer

The **Microsoft Store version** of Claude Desktop cannot launch local MCP servers due to UWP sandboxing. Install Claude Desktop from [claude.ai/download](https://claude.ai/download) instead.

## MCP Tools

### `convert_url`

Convert a single webpage URL to Markdown.

```
Input: { url: "https://example.com/article" }
Output: { markdown: "# Article Title\n...", metadata: { title, wordCount, readingTime } }
```

### `batch_convert`

Convert multiple URLs at once (up to 50).

```
Input: { urls: ["https://...", "https://..."] }
Output: [{ url, markdown, metadata }, ...]
```

### `agent_convert` / `agent_batch_convert`

Convert URLs through the Chrome extension's real browser session (requires Agent Bridge setup). Works on Reddit, login-protected sites, and JS-rendered pages.

## Agent Bridge

For full browser-based conversion (bypasses anti-bot), see [Agent Bridge docs](https://web2md.org/docs/advanced/agent-bridge).

## Links

- Website: https://web2md.org
- Chrome Web Store: https://chromewebstore.google.com/detail/web2md/ijmgpkkfgpijifldbjafjiapehppcbcn
- Documentation: https://web2md.org/docs
- Support: support@web2md.org
