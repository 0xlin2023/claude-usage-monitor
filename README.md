# Claude Usage Monitor

A VS Code extension that monitors your Claude (claude.ai) usage and displays it in the status bar.

## Features

- **Real-time status bar display** — see your Claude usage at a glance with color-coded indicators (green/yellow/red)
- **Auto-fetch from claude.ai** — automatically retrieves usage data using your session key
- **Dual rate-limit tracking** — monitors both 5-hour and 7-day usage windows
- **Extra usage tracking** — shows overage billing if enabled on your account
- **Manual input mode** — set usage manually for subscription (message count) or API (dollar spend) tracking
- **Plan detection** — automatically detects Free, Pro, or Max plans
- **Configurable refresh** — adjustable auto-refresh interval (default: 5 minutes)
- **Configurable thresholds** — customize warning (yellow) and critical (red) percentage levels

## Installation

1. Download the `.vsix` file from [Releases](https://github.com/0xlin2023/claude-usage-monitor/releases)
2. In VS Code, open the Command Palette (`Ctrl+Shift+P`) and run `Extensions: Install from VSIX...`
3. Select the downloaded `.vsix` file

Or build from source:

```bash
npm install
npx vsce package
```

## Setup

### Auto Mode (Recommended)

1. Open claude.ai in your browser
2. Press `F12` to open DevTools -> Application -> Cookies
3. Copy the `sessionKey` value
4. In VS Code, run command `Claude Usage: Set Session Key` and paste the key

The extension will automatically fetch your usage data and keep it updated.

### Manual Mode

Run command `Claude Usage: Set Usage Manually` to enter your current usage numbers.

## Commands

| Command | Description |
|---------|-------------|
| `Claude Usage: Refresh` | Manually refresh usage data |
| `Claude Usage: Set Session Key` | Set the claude.ai session key for auto-fetch |
| `Claude Usage: Set Usage Manually` | Enter usage numbers manually |
| `Claude Usage: Show Details` | View detailed usage breakdown |
| `Claude Usage: Select Tracking Mode` | Switch between subscription and API tracking |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeUsage.refreshInterval` | `300` | Auto-refresh interval in seconds |
| `claudeUsage.warningThreshold` | `80` | Usage % to show warning (yellow) |
| `claudeUsage.criticalThreshold` | `95` | Usage % to show critical (red) |

## How It Works

The extension calls the claude.ai API (`/api/organizations` and `/api/organizations/{id}/usage`) using your session cookie to retrieve real-time rate limit data, including:

- **5-hour window** utilization and reset time
- **7-day window** utilization and reset time
- **Extra usage** credits consumed and monthly limit

The session key is stored securely via VS Code's `SecretStorage` API and never leaves your machine except to authenticate with claude.ai.

## License

MIT
