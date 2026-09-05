// Registers the AIShop4U MCP server in Claude Desktop's config, on any OS.
//
//   node scripts/setup-claude.mjs
//
// Why a script: Claude Desktop launches the server with a minimal PATH (dock apps
// don't inherit your shell PATH), so a bare "node" command fails with "Server
// disconnected" whenever node lives somewhere the GUI PATH doesn't cover (Homebrew
// on macOS, nvm, etc.). We sidestep that by writing the ABSOLUTE path to the node
// running this script — process.execPath — which is correct on macOS, Windows and
// Linux alike. The config file itself is per-machine and never committed, so each
// teammate runs this once on their own machine.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverMain = path.join(REPO, "packages", "mcp-server", "dist", "main.js");

// Claude Desktop config location per OS.
function configPath() {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default: // linux and others
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Claude", "claude_desktop_config.json");
  }
}

const cfgFile = configPath();

if (!fs.existsSync(serverMain)) {
  console.error(`Built server not found at:\n  ${serverMain}\nBuild it first:  npm run build\n`);
  process.exit(1);
}

// Merge into any existing config, preserving every other key the user has.
let config = {};
if (fs.existsSync(cfgFile)) {
  try {
    config = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  } catch (e) {
    console.error(`Existing config is not valid JSON, refusing to overwrite:\n  ${cfgFile}\n  ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
} else {
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
}

config.mcpServers = {
  ...(config.mcpServers ?? {}),
  aishop4u: {
    command: process.execPath, // absolute path to THIS node — the OS-agnostic fix
    args: [serverMain, "--stdio"],
  },
};

fs.writeFileSync(cfgFile, JSON.stringify(config, null, 2) + "\n");

console.log(`AIShop4U registered in Claude Desktop.
  config:  ${cfgFile}
  node:    ${process.execPath}
  server:  ${serverMain}

Next:
  1. Start the shops server:   npm run dev -w @aishop4u/shops
  2. FULLY quit Claude Desktop (from the tray/menu bar, not just the window) and reopen.
  3. New chat, web search OFF:  "Use AIShop4U: I want to buy a laptop"  (range 300 to 1300)
`);
