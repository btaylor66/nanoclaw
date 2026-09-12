/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execFile, execSync } from 'child_process';
import os from 'os';
import { promisify } from 'util';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/**
 * Upper bound for the `docker stop` / `docker ps` calls in this module. A hung
 * daemon must never block the host: a synchronous call without a timeout
 * blocks the whole event loop (observed: `docker stop` stuck 15h, freezing
 * routing, delivery and ncl). `docker stop -t 1` completes in ~1-2s when the
 * daemon is healthy. Other runtime calls keep their own bounds (`docker info`
 * below, egress-lockdown.ts, the image build in container-runner.ts).
 */
export const RUNTIME_CLI_TIMEOUT_MS = 20_000;

const execFileAsync = promisify(execFile);

/**
 * True when a runtime CLI call was cut off by its timeout: Node kills the
 * child and marks the error `killed`. The container's state is then unknown
 * (the daemon may still be stopping it, or may be hung).
 */
export function isRuntimeTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { killed?: unknown }).killed === true;
}

const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function assertContainerName(name: string): void {
  if (!CONTAINER_NAME_RE.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/**
 * Stop a container by name, synchronously. Only for startup paths where
 * blocking is acceptable (see cleanupOrphans); the running host uses
 * stopContainerAsync. The name is validated so the shell command is safe.
 */
export function stopContainer(name: string): void {
  assertContainerName(name);
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, {
    stdio: 'pipe',
    timeout: RUNTIME_CLI_TIMEOUT_MS,
  });
}

/**
 * Stop a container by name without blocking the event loop. Rejects when the
 * runtime reports an error or the call exceeds RUNTIME_CLI_TIMEOUT_MS. The
 * CLI child is SIGKILLed on timeout — the docker client installs its own
 * SIGTERM handler that cancels over the same (possibly hung) connection, so
 * a plain SIGTERM could leave the promise pending forever.
 */
export async function stopContainerAsync(name: string): Promise<void> {
  assertContainerName(name);
  await execFileAsync(CONTAINER_RUNTIME_BIN, ['stop', '-t', '1', name], {
    timeout: RUNTIME_CLI_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
        timeout: RUNTIME_CLI_TIMEOUT_MS,
      },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
