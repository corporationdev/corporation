# VSCode Web Integration Research: code-server + E2B

## Executive Summary

This document outlines how to integrate [code-server](https://github.com/coder/code-server) from Coder with your existing E2B sandbox infrastructure to provide a web-based VSCode editor for code running inside sandboxes.

## What is code-server?

code-server is an open-source project by Coder that allows you to run VSCode in the browser. It's self-hosted, free, and can run on any machine with minimal resources.

**Key Features:**
- Full VSCode experience in the browser
- Runs on any machine with 1GB RAM and 2 vCPUs
- WebSockets support required
- Latest version: v4.109.5 (includes Code v1.109.5, released March 2, 2026)

**Important Difference:** code-server uses the open-source core of VSCode but cannot access Microsoft's official marketplace due to licensing restrictions. It has its own extension marketplace.

## Current Architecture Analysis

### Your E2B Setup

Based on your codebase:

1. **E2B Sandboxes**: Your spaces run in E2B sandboxes (Firecracker microVMs)
   - Located in: `packages/backend/convex/lib/sandbox.ts`
   - Each sandbox has a unique `sandboxId`
   - Sandboxes expose ports via `sandbox.getHost(port)` returning URLs like `https://<sandbox-host>`

2. **Space Sidebar**: `packages/app/src/components/space-sidebar.tsx`
   - Already has preview functionality (port 3001 by default)
   - Opens previews in new tabs via `window.open(data.url, "_blank")`
   - Perfect place to add "Open in VSCode Web" button

3. **Sandbox API**: `apps/server/src/sandbox.ts`
   - Has `/preview` endpoint that generates E2B preview URLs
   - Can be extended to support code-server port

## Integration Architecture

### Option 1: Run code-server in Each Sandbox (Recommended)

**How it works:**
1. Install code-server in your E2B sandbox template or at runtime
2. Start code-server on a specific port (e.g., 8080)
3. Expose it via E2B's port mapping
4. Add button in space-sidebar to open the code-server URL

**Advantages:**
- Each space gets its own isolated VSCode instance
- Direct access to sandbox filesystem
- No additional infrastructure needed
- Works with existing E2B preview system

**Implementation Steps:**

#### 1. Add code-server to E2B Sandbox

There are two approaches:

**A. Install at Runtime (Quick Start)**

Add to `packages/backend/convex/lib/sandbox.ts` in the `setupSandbox` function:

```typescript
// After git clone/pull, install code-server
await runRootCommand(
  sandbox,
  "curl -fsSL https://code-server.dev/install.sh | sh",
  {
    cwd: workdir,
    timeoutMs: 300_000, // 5 minutes
    onStdout: appendLog,
    onStderr: appendLog,
  }
);
```

**B. Pre-install in Custom E2B Template (Faster)**

Create a custom E2B template with code-server pre-installed:

1. Create a Dockerfile:
```dockerfile
FROM e2bdev/code-interpreter:latest

# Install code-server
RUN curl -fsSL https://code-server.dev/install.sh | sh

# Configure code-server
RUN mkdir -p /root/.config/code-server
RUN echo "bind-addr: 0.0.0.0:8080" > /root/.config/code-server/config.yaml && \
    echo "auth: none" >> /root/.config/code-server/config.yaml && \
    echo "cert: false" >> /root/.config/code-server/config.yaml
```

2. Build and publish to E2B (see [E2B Custom Templates](https://e2b.dev/docs/sandbox-template))

#### 2. Start code-server in Sandbox

Add a new function to `packages/backend/convex/lib/sandbox.ts`:

```typescript
const CODE_SERVER_SESSION_NAME = "codeserver";
const CODE_SERVER_PORT = 8080;

export async function startCodeServer(
  sandbox: Sandbox,
  env: SandboxEnv,
  appendLog?: (chunk: string) => void
): Promise<void> {
  const { repository } = env;
  const workdir = getSandboxWorkdir(repository);

  appendLog?.(`Starting code-server on port ${CODE_SERVER_PORT}...\n`);

  // Kill existing session if present
  try {
    await sandbox.commands.run(
      `tmux kill-session -t ${CODE_SERVER_SESSION_NAME}`
    );
  } catch {
    // Session doesn't exist, ignore
  }

  // Start code-server in tmux session
  await runRootCommand(
    sandbox,
    `tmux new-session -d -s ${CODE_SERVER_SESSION_NAME} -c ${quoteShellArg(workdir)} code-server --bind-addr 0.0.0.0:${CODE_SERVER_PORT} --auth none ${quoteShellArg(workdir)}`
  );

  appendLog?.(`code-server started on port ${CODE_SERVER_PORT}.\n`);
}

export async function killCodeServer(sandbox: Sandbox): Promise<void> {
  try {
    await sandbox.commands.run(
      `tmux kill-session -t ${CODE_SERVER_SESSION_NAME}`
    );
  } catch (error) {
    if (isCommandExitError(error)) {
      return; // Session doesn't exist
    }
    throw error;
  }
}

export { CODE_SERVER_PORT };
```

#### 3. Add Button to Space Sidebar

Modify `packages/app/src/components/space-sidebar.tsx`:

```typescript
import { FileCodeIcon } from "lucide-react"; // Add this import

// In SpaceSidebarContent component, add new mutation:
const codeServerMutation = useTanstackMutation({
  mutationFn: async () => {
    if (!space.sandboxId) {
      throw new Error("Space has no sandbox");
    }
    const res = await apiClient.sandbox.preview.$get({
      query: { sandboxId: space.sandboxId, port: "8080" }, // code-server port
    });
    const data = await res.json();
    if ("url" in data) {
      window.open(data.url, "_blank");
    }
  },
});

// Add button in the return statement (after "New Terminal" button):
{isStarted && (
  <Button
    className="w-full justify-start gap-2"
    disabled={codeServerMutation.isPending || space.status !== "running"}
    onClick={() => codeServerMutation.mutate()}
    size="sm"
    variant="outline"
  >
    {codeServerMutation.isPending ? (
      <LoaderIcon className="size-4 animate-spin" />
    ) : (
      <FileCodeIcon className="size-4" />
    )}
    {codeServerMutation.isPending ? "Loading..." : "Open VSCode Web"}
  </Button>
)}
```

#### 4. Auto-Start code-server (Optional)

Add to the space setup flow to automatically start code-server when a space is created:

In your sandbox initialization logic (likely in `packages/backend/convex/sandboxActions.ts`), after `setupSandbox`:

```typescript
await startCodeServer(sandbox, env, appendLog);
```

### Option 2: Central code-server Instance with Remote Filesystem

**How it works:**
1. Run a single code-server instance
2. Use VSCode's Remote Filesystem API to connect to different sandboxes
3. More complex but saves resources

**Pros:**
- Single code-server instance
- Lower resource usage

**Cons:**
- Much more complex to implement
- Requires custom VSCode extension
- Filesystem synchronization challenges
- Not recommended for MVP

## Security Considerations

### Authentication

code-server supports several auth methods:

1. **No Auth** (behind E2B's built-in URL security):
   - E2B URLs are already cryptographically unique and hard to guess
   - Simplest approach for MVP
   - Use `--auth none` flag

2. **Password** (if needed):
   ```bash
   code-server --auth password --password <your-password>
   ```

3. **Proxy Auth** (if using reverse proxy):
   - Use `--skip-auth-preflight` for CORS preflight requests
   - Set up authentication headers in your proxy

### CORS and iframe Embedding

Based on research:
- code-server **can** be embedded in iframes
- May need to configure CORS headers if embedding
- For opening in new tab (recommended), no special config needed

### E2B Security

E2B URLs are already secure:
- Each port exposure gets a unique, cryptographically secure URL
- URLs are not guessable
- Sandboxes are isolated Firecracker microVMs
- No additional authentication strictly necessary for MVP

## Configuration Options

### Environment Variables

From [LinuxServer.io code-server docs](https://docs.linuxserver.io/images/docker-code-server/):

```yaml
environment:
  - PASSWORD=optional_password       # Optional password
  - SUDO_PASSWORD=sudo_password      # Optional sudo password
  - PROXY_DOMAIN=code.example.com    # Optional proxy domain
  - DEFAULT_WORKSPACE=/workspace     # Default workspace path
```

For your E2B sandboxes, you'd set these when starting code-server:

```bash
code-server \
  --bind-addr 0.0.0.0:8080 \
  --auth none \
  /root/owner-repo
```

### CLI Flags

Key flags for code-server:

```bash
--bind-addr <addr>:<port>   # Bind address (use 0.0.0.0:8080)
--auth <type>                # none, password
--cert                       # Enable HTTPS (not needed with E2B)
--disable-telemetry          # Disable telemetry
--disable-update-check       # Disable update checks
```

## Implementation Checklist

- [ ] Decide: Runtime install vs. Custom E2B template
- [ ] Add `startCodeServer()` and `killCodeServer()` functions to `packages/backend/convex/lib/sandbox.ts`
- [ ] Integrate code-server startup into space creation flow
- [ ] Add "Open VSCode Web" button to `space-sidebar.tsx`
- [ ] Test with existing E2B preview infrastructure
- [ ] (Optional) Add code-server status tracking to space state
- [ ] (Optional) Add button to stop code-server
- [ ] (Optional) Save user VSCode settings/extensions across sessions

## Advanced Features (Future)

### 1. Extension Marketplace

code-server has its own extension marketplace. You could:
- Pre-install common extensions in your E2B template
- Allow users to install extensions per-space

### 2. Settings Sync

- Save VSCode settings to Convex
- Restore settings when opening code-server
- Per-user or per-space settings

### 3. Collaborative Editing

- Use code-server with Live Share-like features
- Multiple users editing same codebase

### 4. Terminal Integration

- code-server has built-in terminal
- Could replace or complement your current terminal implementation

## References

### Documentation
- [code-server GitHub](https://github.com/coder/code-server)
- [code-server Docs](https://coder.com/docs/code-server)
- [E2B Documentation](https://e2b.dev/docs)
- [E2B Custom Templates](https://e2b.dev/docs/sandbox-template)

### Configuration
- [LinuxServer.io code-server](https://docs.linuxserver.io/images/docker-code-server/)
- [code-server Install Guide](https://coder.com/docs/code-server/install)
- [code-server Security Guide](https://coder.com/docs/code-server/guide)

### Integration Examples
- [code-server iframe Discussion](https://github.com/coder/code-server/issues/621)
- [code-server Proxy Auth](https://coder.com/docs/code-server/guide)
- [E2B + Docker Integration](https://www.docker.com/blog/docker-e2b-building-the-future-of-trusted-ai/)

## Recommended Next Steps

1. **Quick Prototype (1-2 hours)**:
   - Add runtime installation of code-server
   - Add button to space-sidebar
   - Test with existing preview infrastructure

2. **Production Ready (1-2 days)**:
   - Create custom E2B template with code-server pre-installed
   - Add auto-start on space creation
   - Add status tracking (running/stopped)
   - Add start/stop buttons

3. **Enhanced Experience (1 week)**:
   - Pre-install popular extensions
   - Settings persistence
   - Custom keybindings/themes

## Questions to Consider

1. **When to start code-server?**
   - Auto-start on space creation?
   - On-demand when user clicks button?
   - Keep running always or auto-stop?

2. **Port configuration?**
   - Fixed port (8080) or configurable?
   - Conflict with dev server ports?

3. **User experience?**
   - New tab (recommended) or iframe?
   - Desktop VSCode connection possible?

4. **Resource management?**
   - code-server adds ~100-200MB RAM overhead
   - Acceptable for E2B sandboxes?

5. **Extension marketplace?**
   - Use code-server marketplace?
   - Pre-install extensions?
   - Allow user installs?

---

**Recommendation:** Start with Option 1 (code-server per sandbox) using runtime installation for quick prototyping, then move to custom E2B template for production once validated.
