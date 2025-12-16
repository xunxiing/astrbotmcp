# @xunxiing/astrbot-mcp

NPM package for AstrBot MCP server (CLI wrapper).

This repository also publishes the Python package `astrbotmcp` to PyPI.

## Usage

Recommended:

```bash
npx @xunxiing/astrbot-mcp
```

This wrapper starts the Python CLI via `uvx`:

```bash
uvx --from astrbotmcp astrbot-mcp
```

## CI publish

GitHub Actions publishes this package on GitHub Release `published`.

Required repo secret:

- `NPM_TOKEN`: npm **Automation** token with permission to publish `@xunxiing/astrbot-mcp`.

