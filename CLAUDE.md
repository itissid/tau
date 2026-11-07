# Claude Instructions

## Package identity

Repo: **tau** | npm package: **tau-mirror**

Production install (OS-independent):
```
npm install -g git+https://github.com/deflating/tau.git#main
```

## How Pi loads tau

Pi loads tau from a separate npm project that **shadows the global npm install**:

| OS      | Path |
|---------|------|
| Windows | `%USERPROFILE%\.pi\agent\npm\node_modules\tau-mirror\` |
| macOS   | _to-be-done_ |

## Local dev setup

Run automatically when asked to make or test changes locally.

**Windows (PowerShell):**
```powershell
# Remove Pi's shadowing copy
cd "$env:USERPROFILE\.pi\agent\npm"
npm uninstall tau-mirror

# Link this repo to global npm
cd "<repo root>"
npm link
```

**macOS:**
```bash
# to-be-done
```

After any change to `extensions/mirror-server.ts` — clear jiti cache, then tell the user to restart Pi:

**Windows:**
```powershell
Remove-Item "$env:LOCALAPPDATA\Temp\jiti" -Recurse -Force -ErrorAction SilentlyContinue
```

**macOS:**
```bash
# to-be-done
```

`public/` changes take effect on browser reload — no Pi restart needed.

## Restore production install

**Windows:**
```powershell
npm install -g git+https://github.com/deflating/tau.git#main
```

**macOS:**
```bash
# to-be-done
```

## Agent skills

### Issue tracker

Issues are tracked as local Markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five-label triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context domain documentation layout. See `docs/agents/domain.md`.
