#!/bin/sh
# Merges mcp/servers.json into the active LLM CLI's config at boot.
# Supports: gemini, claude, codex. Controlled by AGENT_CLI env var.
# See documents/FEAT-1/development/gemini-cli-tools.md
set -eu

MCP_SERVERS="/etc/openab/mcp-servers.json"
AGENT_CLI="${AGENT_CLI:-gemini}"

if [ ! -f "$MCP_SERVERS" ]; then
  echo "render-mcp-config: $MCP_SERVERS not found, skipping" >&2
  exit 0
fi

# Helper: expand $VAR and ${VAR} references from process.env in all string
# values of the MCP servers JSON. Runs via inline Node (jq unavailable).
expand_and_read_servers() {
  node -e "
    const servers = JSON.parse(require('fs').readFileSync('$MCP_SERVERS','utf8'));
    const expand = (v) => {
      if (typeof v === 'string')
        return v.replace(/\\\$\\\{([^}]+)\\\}|\\\$([A-Za-z_][A-Za-z0-9_]*)/g,
          (_, b, p) => process.env[b || p] || '');
      if (Array.isArray(v)) return v.map(expand);
      if (v && typeof v === 'object')
        return Object.fromEntries(Object.entries(v).map(([k,val]) => [k, expand(val)]));
      return v;
    };
    process.stdout.write(JSON.stringify(expand(servers)));
  "
}

case "$AGENT_CLI" in
  gemini)
    # Gemini CLI: merge mcpServers into ~/.gemini/settings.json
    BASE="/home/node/.gemini/settings.json"
    OUT="$BASE"
    if [ ! -f "$BASE" ]; then
      echo "render-mcp-config: $BASE not found" >&2
      exit 1
    fi
    EXPANDED=$(expand_and_read_servers)
    node -e "
      const base = JSON.parse(require('fs').readFileSync('$BASE','utf8'));
      base.mcpServers = JSON.parse(process.argv[1]);
      require('fs').writeFileSync('$OUT', JSON.stringify(base, null, 2) + '\n');
    " "$EXPANDED"
    echo "render-mcp-config: merged MCP servers into $OUT (gemini)" >&2
    ;;

  claude)
    # Claude Code: write .mcp.json in working directory
    OUT="/home/node/.mcp.json"
    EXPANDED=$(expand_and_read_servers)
    node -e "
      const config = { mcpServers: JSON.parse(process.argv[1]) };
      require('fs').writeFileSync('$OUT', JSON.stringify(config, null, 2) + '\n');
    " "$EXPANDED"
    echo "render-mcp-config: wrote $OUT (claude)" >&2
    ;;

  codex)
    # OpenAI Codex CLI: convert to TOML config
    OUT="/home/node/.codex/config.toml"
    mkdir -p /home/node/.codex
    EXPANDED=$(expand_and_read_servers)
    node -e "
      const servers = JSON.parse(process.argv[1]);
      let toml = '';
      for (const [name, cfg] of Object.entries(servers)) {
        toml += '[mcp_servers.' + name + ']\n';
        toml += 'command = \"' + cfg.command + '\"\n';
        if (cfg.args && cfg.args.length) {
          toml += 'args = [' + cfg.args.map(a => '\"' + a + '\"').join(', ') + ']\n';
        }
        if (cfg.env) {
          toml += '[mcp_servers.' + name + '.env]\n';
          for (const [k, v] of Object.entries(cfg.env)) {
            toml += k + ' = \"' + v + '\"\n';
          }
        }
        toml += '\n';
      }
      require('fs').writeFileSync('$OUT', toml);
    " "$EXPANDED"
    echo "render-mcp-config: wrote $OUT (codex)" >&2
    ;;

  *)
    echo "render-mcp-config: unknown AGENT_CLI='$AGENT_CLI', skipping MCP merge" >&2
    ;;
esac
