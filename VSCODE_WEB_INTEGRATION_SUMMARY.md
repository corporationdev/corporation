# VSCode Web Integration Implementation

## Overview
Successfully integrated code-server (VSCode in the browser) with E2B sandboxes, allowing users to open a full VSCode interface to edit code running inside their sandbox.

## Implementation Details

### Architecture
**On-Demand Installation Approach**
- Code-server is installed and started the first time a user clicks "Open VSCode Web"
- Runs in a persistent tmux session on port 8080
- Uses E2B's built-in port exposure for secure access

### Files Changed

#### 1. Backend Sandbox API (`apps/server/src/sandbox.ts`)
**New endpoint:** `GET /sandbox/code-server?sandboxId={id}`

**Functionality:**
- Connects to E2B sandbox
- Checks if code-server is running (via tmux session check)
- Installs code-server if not present (~30-60s first time)
- Starts code-server in tmux session
- Waits for it to be ready (health check on localhost:8080)
- Returns secure E2B URL: `https://{sandbox-id}-8080.e2b.dev`

**Helper functions:**
- `isCodeServerRunning()` - Check tmux session
- `isCodeServerInstalled()` - Check if binary exists
- `installCodeServer()` - Run official install script
- `startCodeServer()` - Launch in tmux
- `ensureCodeServerRunning()` - Orchestrates the whole flow

#### 2. Sandbox Library (`packages/backend/convex/lib/sandbox.ts`)
Added utility functions (currently unused but available for future Convex actions):
- `startCodeServer()` - Full setup with logging
- `killCodeServer()` - Stop tmux session
- `hasCodeServerSession()` - Check if running

#### 3. Frontend UI (`packages/app/src/components/space-sidebar.tsx`)
**New button:** "Open VSCode Web"
- Located in space sidebar, below "Open Preview"
- Only visible when sandbox is running
- Shows loading state while starting code-server
- Opens VSCode Web in new tab on success

**Code changes:**
- Added `CodeIcon` import from lucide-react
- Created `codeServerMutation` TanStack Query mutation
- Added button with loading/disabled states

## How It Works

```
User clicks "Open VSCode Web"
    ↓
Frontend calls /sandbox/code-server API
    ↓
API connects to E2B sandbox
    ↓
Check if tmux session "codeserver" exists
    ↓ (if not)
Check if code-server binary installed
    ↓ (if not)
Download and install via official script (30-60s)
    ↓
Start code-server in tmux on port 8080
    ↓
Poll localhost:8080 until healthy (max 30s)
    ↓
Return URL: https://{sandbox-id}-8080.e2b.dev
    ↓
Frontend opens URL in new tab
    ↓
User sees full VSCode Web interface with their code!
```

## Configuration

### Code-server Settings
- **Port:** 8080
- **Tmux session:** `codeserver`
- **Auth:** None (secured via E2B's cryptographic URLs)
- **Bind address:** 0.0.0.0 (accessible from outside)
- **Working directory:** Auto-detected from sandbox (usually `/root/owner-repo`)

### Timeouts
- **Installation:** 120 seconds
- **Startup wait:** 30 seconds (30 attempts × 1 second)
- **Health check:** 2 seconds per attempt

## Testing

### To Test:
1. Start or create a space
2. Wait for sandbox status to be "running"
3. Look for "Open VSCode Web" button in right sidebar
4. Click the button
5. First time: Wait 30-60 seconds for installation + startup
6. Subsequent times: Opens immediately (2-3 seconds)
7. VSCode Web should open in new tab

### Expected Behavior:
- ✅ First click installs code-server (slow but one-time)
- ✅ Subsequent clicks reuse existing session (fast)
- ✅ Code-server persists in tmux even if browser closes
- ✅ Full VSCode experience with file browser, terminal, extensions
- ✅ Direct file system access to sandbox code

## Future Enhancements (Not Implemented)

### Possible Improvements:
1. **Pre-install in E2B template** - Eliminate first-time wait
2. **Start/stop buttons** - Allow users to stop code-server to free resources
3. **Status indicator** - Show if code-server is running before clicking
4. **Auto-start on space creation** - Have it ready when user arrives
5. **Custom port configuration** - Allow users to change default port
6. **Extension sync** - Sync VSCode extensions across spaces
7. **Settings persistence** - Save VSCode settings between sessions

## Security

### Current Security:
- ✅ E2B URLs are cryptographically secure (no additional auth needed)
- ✅ Each sandbox has unique URL that's impossible to guess
- ✅ Code-server only accessible via E2B's secure tunnel
- ✅ No password needed due to E2B's URL security

### Considerations:
- Code-server runs with root user (matches sandbox pattern)
- Auth disabled (--auth none) - acceptable because E2B URLs are secure
- No HTTPS cert needed - E2B handles TLS termination

## Known Limitations

1. **First-time installation delay** - 30-60 seconds on first use per sandbox
2. **Memory usage** - Code-server uses ~200-300MB RAM
3. **Extensions** - Uses open-vsx marketplace, not Microsoft's official one
4. **No persistence** - If sandbox is killed, code-server state is lost
5. **Type check OOM** - Unrelated to this PR, existing issue with large codebase

## Resources

- [code-server GitHub](https://github.com/coder/code-server)
- [code-server Docs](https://coder.com/docs/code-server)
- [E2B Port Exposure](https://e2b.dev/docs/sandbox/api/reference#get-host)
- [Research Document](./RESEARCH_VSCODE_WEB_INTEGRATION.md)
