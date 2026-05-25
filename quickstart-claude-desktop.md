# Quickstart — Claude Desktop (No Code Required)

Add persistent memory to Claude Desktop. No coding, no cloning a repo with git, no build step. Install three free tools, run two commands, paste one config file. Your conversations with Claude will be remembered across sessions in a local database on your own computer.

**Time:** about 15 minutes the first time. Most of it is waiting for installers and the database to come up.

**Where your data lives:** entirely on your computer, in a SQL Server database that Docker runs locally. Nothing leaves your machine.

---

## What you'll need

| Tool | What it does | Where to get it |
|------|--------------|------------------|
| **Claude Desktop** | The Claude app that will use the memory | <https://claude.ai/download> |
| **Docker Desktop** | Runs the local memory database | <https://www.docker.com/products/docker-desktop/> |
| **Node.js (LTS)** | Runs the small connector program | <https://nodejs.org/> — pick the **LTS** download |

> **Linux users:** Official Claude Desktop is Mac + Windows. On Linux, the same MCP config works with community Claude Desktop builds, or with [Cline](https://github.com/cline/cline) (a VS Code extension that speaks MCP). The Docker + database steps below are identical on Linux.

---

## Step 1 — Install the three tools

Install each one and accept the defaults. You don't need to do anything special during the installs.

- **Claude Desktop** — download and run the installer.
- **Docker Desktop** — download and run the installer. On Windows it will set up WSL2 automatically; restart the computer if it asks. After install, **open Docker Desktop once** and let it finish starting — you should see "Docker Desktop is running" in the bottom-left.
- **Node.js (LTS)** — download and run the installer. Accept defaults.

You don't need to be a developer to do any of this. Each is a regular app installer.

---

## Step 2 — Download the database setup files

Deep Memory ships a ready-made database setup. You're going to download the project files as a ZIP (no git required) and use one folder from it.

1. Go to <https://github.com/TjWheeler/deep-memory>.
2. Click the green **Code** button → **Download ZIP**.
3. Extract the ZIP somewhere you'll remember — for example:
   - Windows: `C:\deep-memory`
   - Mac: `~/deep-memory` (your home folder)
   - Linux: `~/deep-memory`

> Tip: avoid extracting to OneDrive, iCloud, or Dropbox folders. Cloud-sync can interfere with Docker.

---

## Step 3 — Start the memory database

Open a terminal (a window where you type commands):

- **Windows:** open **PowerShell** (press the Start key, type "powershell", press Enter).
- **Mac:** open **Terminal** (Cmd-Space, type "terminal", press Enter).
- **Linux:** open your terminal of choice.

Change into the folder where you extracted the ZIP:

```bash
cd C:\deep-memory          # Windows
cd ~/deep-memory           # Mac / Linux
```

Start the database:

```bash
docker compose up sqlserver -d
```

The first time this runs, Docker downloads and builds the database image. It can take 5–10 minutes. Subsequent starts take seconds.

Check progress until you see `healthy`:

```bash
docker compose ps sqlserver
```

Repeat the command every minute. When the **STATUS** column shows `Up X minutes (healthy)`, you're ready.

Now create the database that Deep Memory will use:

```bash
docker exec deep-memory-sqlserver /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "DeepMem@Dev1234" -C -Q "CREATE DATABASE [deep-memory]"
```

You should see output ending with something like `Changed database context to 'master'.` That means it worked.

> **Security note:** the default password `DeepMem@Dev1234` is fine for a local-only database that nothing outside your machine can reach. Don't expose this database to the internet without changing the password in `docker-compose.yml` first.

The database will now restart automatically every time Docker Desktop starts. You only need to do Step 3 once.

---

## Step 4 — Tell Claude Desktop about the memory server

Claude Desktop reads its configuration from a single JSON file. You're going to open that file (creating it if it doesn't exist) and paste the snippet below.

### 4a. Open the config file

**Windows:**

1. Press **Win+R**, type the following, and press Enter:
   ```
   %APPDATA%\Claude
   ```
2. If the folder is empty or doesn't contain `claude_desktop_config.json`, right-click → **New** → **Text Document**, then rename it to `claude_desktop_config.json` (make sure Windows doesn't add a hidden `.txt` extension — show file extensions in Explorer if unsure).
3. Open the file in Notepad.

**Mac:**

1. In Finder, press **Cmd+Shift+G** and paste:
   ```
   ~/Library/Application Support/Claude
   ```
2. If `claude_desktop_config.json` isn't there, create it (right-click → New File, or use TextEdit's **File → New** then save as `claude_desktop_config.json` in this folder, **format: Plain Text**).
3. Open it in TextEdit.

**Linux:**

1. Open the file in your editor:
   ```bash
   nano ~/.config/Claude/claude_desktop_config.json
   ```
2. Create the folder first if it doesn't exist:
   ```bash
   mkdir -p ~/.config/Claude
   ```

### 4b. Paste the configuration

Replace the entire contents of the file with the block for your operating system.

**Mac and Linux:**

```json
{
  "mcpServers": {
    "deep-memory": {
      "command": "npx",
      "args": ["-y", "@utaba/deep-memory-local-mcp-server"],
      "env": {
        "DEEP_MEMORY_ACTOR_ID": "claude-desktop",
        "DEEP_MEMORY_ACTOR_TYPE": "agent",
        "DEEP_MEMORY_STORAGE": "sqlserver",
        "DEEP_MEMORY_SQL_HOST": "localhost",
        "DEEP_MEMORY_SQL_PORT": "1435",
        "DEEP_MEMORY_SQL_DATABASE": "deep-memory",
        "DEEP_MEMORY_SQL_USER": "sa",
        "DEEP_MEMORY_SQL_PASSWORD": "DeepMem@Dev1234",
        "DEEP_MEMORY_SQL_TRUST_CERT": "true"
      }
    }
  }
}
```

**Windows:**

Windows needs `cmd /c` in front of `npx` so the launcher can find it. Use this exact block:

```json
{
  "mcpServers": {
    "deep-memory": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@utaba/deep-memory-local-mcp-server"],
      "env": {
        "DEEP_MEMORY_ACTOR_ID": "claude-desktop",
        "DEEP_MEMORY_ACTOR_TYPE": "agent",
        "DEEP_MEMORY_STORAGE": "sqlserver",
        "DEEP_MEMORY_SQL_HOST": "localhost",
        "DEEP_MEMORY_SQL_PORT": "1435",
        "DEEP_MEMORY_SQL_DATABASE": "deep-memory",
        "DEEP_MEMORY_SQL_USER": "sa",
        "DEEP_MEMORY_SQL_PASSWORD": "DeepMem@Dev1234",
        "DEEP_MEMORY_SQL_TRUST_CERT": "true"
      }
    }
  }
}
```

Save the file. If you already have other MCP servers configured, merge the `deep-memory` entry into your existing `mcpServers` object instead of overwriting the file.

---

## Step 5 — Restart Claude Desktop

Fully **quit** Claude Desktop (don't just close the window — use the menu **Claude → Quit** on Mac, or right-click the tray icon → Quit on Windows). Open it again.

The first time, `npx` will spend ~30 seconds downloading the connector. The Claude Desktop window may show a brief "starting tools" indicator. After that, you should see a small tools icon (a hammer or slider, depending on the version) near the message input. Click it and confirm `deep-memory` is listed with around 28 tools.

---

## Step 6 — Set up your memory

Paste this into Claude Desktop to create your first memory repository:

> Create a new Deep Memory repository called "personal" using the Conversations starter kit. Use governance mode "open". Once it's created, open it and confirm it's ready.

Claude will call a sequence of memory tools. When it finishes, you have a working long-term memory backed by the local database.

Try a real exchange:

> Remember that I prefer tea over coffee, and that I'm working on a side project called "Aurora" — a recipe app for people with food allergies.

Then in a **new conversation** (start a fresh chat):

> What do you remember about me?

Claude should recall your preferences and the Aurora project. The memory survives across conversations, app restarts, and reboots.

---

## Stopping and starting later

You only configured everything once. From now on:

- **The database** starts automatically when Docker Desktop starts. If you stopped Docker Desktop and need the memory, just open Docker Desktop again. To verify the database is running, open Docker Desktop and look at the **Containers** tab — `deep-memory-sqlserver` should be green.
- **The connector** is launched by Claude Desktop every time it starts. You don't manage it.
- **Claude Desktop** automatically reconnects when launched.

If you want to free up resources when not using Claude Desktop, just quit Docker Desktop. Your memory data is preserved on disk and comes back when Docker starts again.

---

## Troubleshooting

**Claude Desktop doesn't show the tools icon.**

Quit Claude Desktop fully and reopen it. If it's still missing, open the config file you edited in Step 4 and check:

- The file is valid JSON (no trailing commas, all quotes balanced). Paste your file's contents into <https://jsonlint.com/> if unsure.
- It's at the exact path described in Step 4 (Windows: inside `%APPDATA%\Claude\`; Mac: inside `~/Library/Application Support/Claude/`).
- On Windows you used the `cmd /c npx ...` form, not just `npx`.

**`docker: command not found` or `docker compose` errors.**

Docker Desktop isn't running. Open it from your Start menu / Applications folder, wait for "Docker Desktop is running", then retry.

**`Login failed for user 'sa'`** when running the `CREATE DATABASE` command.

The database container needs a minute on first run. Run `docker compose ps sqlserver` and wait for `(healthy)` before retrying.

**The tools show up but the first memory operation fails.**

Most often the database wasn't created. Re-run the `docker exec ... CREATE DATABASE [deep-memory]` command from Step 3. It's safe to run again — if the database already exists you'll get a clear error.

**`npx` can't find the package, or a network error on first launch.**

`npx` needs internet the first time it downloads the connector. Make sure you're online, then quit and reopen Claude Desktop. Subsequent launches don't need internet (npx caches the package).

**Port 1435 is already in use.**

Another program on your machine is using port 1435. Open `docker-compose.yml` from the folder you extracted in Step 2, change `"1435:1433"` to (for example) `"1436:1433"`, save, then run `docker compose up sqlserver -d` again. Also update `DEEP_MEMORY_SQL_PORT` in your Claude Desktop config to the new number.

**Where is my data stored?**

In a Docker-managed volume named `deep-memory_sqlserver_data`. To delete everything and start fresh, run `docker compose down -v` in the project folder — that wipes the database volume too.

---

## What's next

- **See what Claude can do with memory.** Ask: *"What tools do you have for working with memory?"* — Claude will list them.
- **Try a different starter kit.** The Conversations kit is for personal long-term memory. Other kits suit different domains: see [README.md](README.md#starter-kits) for the list.
- **Enable semantic search.** By default, Claude can only find memories by exact label, type, or graph traversal — not by meaning. [quickstart-embeddings.md](quickstart-embeddings.md) walks through plugging in an embeddings provider (OpenAI is two extra lines in the config above) so `memory_search_by_concept` works.
- **Move to Claude Code (the CLI).** The same database works with Claude Code — see [quickstart-sqlserver.md](quickstart-sqlserver.md).
- **Export your memory.** Ask Claude: *"Export my 'personal' repository to a file so I can back it up."* Deep Memory writes a `.dkg` archive you can keep, share, or import later.
- **Indexing your own documents.** If you want to load existing notes, manuals, or other documents into a knowledge graph rather than building it up conversationally, see [quickstart-indexer.md](quickstart-indexer.md).
