/**
 * Model Context Protocol (MCP) server configurations
 *
 * Required MCP Servers:
 * 1. GitHub - For PR/repo operations
 * 2. ESLint - For code linting and style analysis
 *
 * Documentation:
 * - MCP Protocol: https://modelcontextprotocol.io
 * - GitHub MCP: https://github.com/github/github-mcp-server
 * - ESLint MCP: https://eslint.org/docs/latest/use/mcp
 */

// Use a getter to ensure environment variables are evaluated at runtime
// after dotenv.config() has been called
export const mcpServersConfig = {
  /**
   * GitHub MCP Server
   * Provides tools for GitHub API operations
   *
   * Note: GITHUB_TOKEN is optional (recommended for private repos and higher rate limits).
   * The GitHub MCP server expects GITHUB_PERSONAL_ACCESS_TOKEN as the env var name.
   * We map our GITHUB_TOKEN from .env to this expected name.
   */
  get github() {
    return {
      type: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN || '' }
    };
  },

  /**
   * ESLint MCP Server
   * Provides tools for linting and code quality analysis
   */
  get eslint() {
    return {
      type: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@eslint/mcp@latest'],
      env: {}
    };
  }
};
