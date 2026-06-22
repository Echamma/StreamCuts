# StreamCuts

Monorepo root for the StreamCuts worktree.

## Contents

- `opencut-classic/` - the OpenCut frontend and core app
- `backend/long-to-short/` - the NestJS backend for clip generation and transcription

## Windows launcher

If you want a double-clickable local launcher that starts the backend and opens the app in your browser:

1. Prepare the production builds once:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\script\prepare-windows-launcher.ps1
   ```

2. Double-click:

   ```text
   .\dist\windows\StreamCutsLauncher.exe
   ```

The launcher is start-only:

- it does not auto-install dependencies
- it does not auto-build the app
- it expects the production backend/frontend artifacts to already exist
