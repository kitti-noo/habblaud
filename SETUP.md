# Setup on a new machine (Docker + commanding agents from the page)

This guide sets up a fresh clone of Habblaud running in Docker with everything turned on: starting agents from the
page, picking the project by browsing folders, the **+** button on each project, typing commands and sending images or
files to agents, and watching their work in real time.

> Written for macOS. Linux works with the same steps, except "Start the bridge automatically" (launchd).
> Everything else is in the [README](README.md).

## Prerequisites

- **Node.js 22.12 or newer** and npm (`node -v`)
- **Docker** (Docker Desktop on a Mac)
- **Claude Code**, installed and logged in (`claude --version`)
- (optional) **Codex**, installed and logged in (`codex --version`)

## Install

```sh
git clone https://github.com/kitti-noo/habblaud.git
cd habblaud
npm install
```

### 1. Turn on commanding agents from the page

Create a `.env` file in the `habblaud` folder:

```sh
echo "HABBLAUD_PTY=1" >> .env
```

Without it, the **New agent** button, **📁 Browse folders…** and the **+** on each project don't show up. `.env` isn't
in git, so every machine needs its own. The page language can go in the same file, e.g. `HABBLAUD_LANG=en`.

### 2. Install the Claude Code plugins

```sh
npm run mod:install
```

The plugins let you send messages to agents and answer permission requests from the page, and they report usage. With
several Claude Code accounts, the command installs them in each one. Check with `npm run mod:status`.

Claude Code sessions that were already open don't load the plugins: open a new session, or type `/reload-plugins` in
the existing one.

Claude Code loads the plugins straight from `habblaud/mod/`. If you move or delete the `habblaud` folder, the plugins
go with it: run `npm run mod:install` again from the new location.

### 3. Run Habblaud in Docker

```sh
npm run docker:up
```

The script finds the Claude Code and Codex accounts on the machine, writes `docker-compose.override.yml` (read-only
mounts of the transcripts only), then builds and starts the container. Open <http://localhost:4747>.

- Logs: `npm run docker:logs`
- Stop: `npm run docker:down`

### 4. Keep the bridge running on the machine

```sh
npm run codex:bridge
```

The container can't see the machine's folders or run `claude` itself. The bridge does that work on the host:

- starts new agents (`claude --bg`)
- lists folders for Browse folders
- saves attachments to `~/.habblaud/attachments/`
- delivers messages to Codex and transcribes dictation (if Whisper is installed)

Keep it running the whole time you use Habblaud. Without it, the page shows
`the computer helper (npm run codex:bridge) isn't running`. To avoid starting it by hand, see
[Start the bridge automatically](#start-the-bridge-automatically-macos).

### 5. Let Claude Code trust your project folders

Agents started from the page only run in the background in folders Claude Code already trusts. For a new project, run
this once and accept the prompt:

```sh
cd /path/to/project
claude
```

In a folder that isn't trusted yet, the Claude app opens with the request filled in, and you press Enter there.

## Usage

| To | Where |
|---|---|
| Start a new agent | **New agent** in the top bar, or the **+** on a project in the side panel |
| Pick the project | Recent list, **+ Other folder** (type a path) or **📁 Browse folders…** |
| Command a running agent | Click the agent and type in the message box (Enter sends, Shift+Enter adds a line) |
| Attach images or files | The paperclip, paste with Cmd+V (e.g. a screenshot) or drop files |
| Watch the work | Click the agent for its terminal, the **Activity** bar at the bottom, each project in the side panel |
| Answer permission requests | A card on the page; no need to go back to the terminal |

Attachments are saved in `~/.habblaud/attachments/` and the agent gets their paths at the end of the message. Old
files aren't deleted automatically; remove them when you no longer need them.

## Start the bridge automatically (macOS)

To have macOS start `npm run codex:bridge` at login and restart it if it crashes, run this in the `habblaud` folder:

```sh
mkdir -p ~/.habblaud ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/com.habblaud.bridge.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.habblaud.bridge</string>
  <key>ProgramArguments</key>
  <array><string>$(which npm)</string><string>run</string><string>codex:bridge</string></array>
  <key>WorkingDirectory</key><string>$(pwd)</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/.habblaud/bridge.log</string>
  <key>StandardErrorPath</key><string>$HOME/.habblaud/bridge.log</string>
</dict>
</plist>
EOF
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.habblaud.bridge.plist
```

The file stores the `habblaud` folder, `npm` and your `PATH` as they are when you run it (`claude` and `codex` must be
in that `PATH`). If you move the folder, remove it first and run it again.

- Status: `launchctl print gui/$(id -u)/com.habblaud.bridge | grep state`
- Log: `tail -f ~/.habblaud/bridge.log`
- Remove: `launchctl bootout gui/$(id -u)/com.habblaud.bridge && rm ~/Library/LaunchAgents/com.habblaud.bridge.plist`

## Updating

```sh
git pull
npm install
npm run docker:up
```

If you run the bridge by hand, stop it (Ctrl+C) and start it again. With launchd:
`launchctl kickstart -k gui/$(id -u)/com.habblaud.bridge`

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| No New agent button or **+** | `.env` is missing `HABBLAUD_PTY=1`, or `npm run docker:up` wasn't run after editing `.env`. Also open the page at `http://localhost:4747`. |
| `the computer helper (npm run codex:bridge) isn't running` | The bridge isn't running (step 4). |
| The message box says the session isn't connected to the plugin | Run `npm run mod:install` and open a new Claude Code session. |
| A new agent opens in the Claude app instead | The folder isn't trusted yet (step 5). |
| A new agent doesn't show up in the office | Wait a few seconds, or check the bridge log for errors. |
