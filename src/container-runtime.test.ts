import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock log
vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock child_process — store the mock fns so tests can configure them. The
// real module is kept around so the hang tests can route a call through the
// actual implementation and prove the timeout option is honored.
const mockExecSync = vi.fn();
const mockExecFile = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: (...args: unknown[]) => mockExecSync(...args),
    execFile: (...args: unknown[]) => mockExecFile(...args),
  };
});

import {
  CONTAINER_RUNTIME_BIN,
  RUNTIME_CLI_TIMEOUT_MS,
  isRuntimeTimeout,
  readonlyMountArgs,
  stopContainer,
  stopContainerAsync,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

// Real implementations for the hang tests (the mock above shadows them).
const actualChildProcess = await vi.importActual<typeof import('child_process')>('child_process');

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('calls docker stop for valid container names with a timeout', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-test-123`, {
      stdio: 'pipe',
      timeout: RUNTIME_CLI_TIMEOUT_MS,
    });
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow('Invalid container name');
    expect(() => stopContainer('foo$(whoami)')).toThrow('Invalid container name');
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('throws instead of hanging when the runtime binary never returns', () => {
    // Route through the real execSync against a process that sleeps far longer
    // than the timeout. The timeout is shortened to keep the test fast; the
    // assertion above pins the production value.
    mockExecSync.mockImplementationOnce((_cmd: string, opts: { timeout: number }) => {
      expect(opts.timeout).toBe(RUNTIME_CLI_TIMEOUT_MS);
      return actualChildProcess.execSync('sleep 30', { ...opts, timeout: 300 });
    });

    const started = Date.now();
    expect(() => stopContainer('nanoclaw-hung-1')).toThrow(/ETIMEDOUT|timed out/i);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('stopContainerAsync', () => {
  it('runs docker stop via execFile (no shell) with a timeout', async () => {
    mockExecFile.mockImplementationOnce(
      (_bin: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => cb(null),
    );

    await expect(stopContainerAsync('nanoclaw-test-456')).resolves.toBeUndefined();
    expect(mockExecFile).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['stop', '-t', '1', 'nanoclaw-test-456'],
      { timeout: RUNTIME_CLI_TIMEOUT_MS, killSignal: 'SIGKILL' },
      expect.any(Function),
    );
  });

  it('rejects (never throws synchronously) for invalid names, without touching the runtime', async () => {
    await expect(stopContainerAsync('foo; rm -rf /')).rejects.toThrow('Invalid container name');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('rejects when the runtime reports an error', async () => {
    mockExecFile.mockImplementationOnce(
      (_bin: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) =>
        cb(new Error('No such container')),
    );

    await expect(stopContainerAsync('nanoclaw-gone-1')).rejects.toThrow('No such container');
  });

  it('rejects instead of hanging when the runtime binary never returns', async () => {
    mockExecFile.mockImplementationOnce(
      (
        _bin: string,
        _args: string[],
        opts: { timeout: number; killSignal: NodeJS.Signals },
        cb: (err: Error | null) => void,
      ) => {
        expect(opts.timeout).toBe(RUNTIME_CLI_TIMEOUT_MS);
        expect(opts.killSignal).toBe('SIGKILL');
        return actualChildProcess.execFile('sleep', ['30'], { ...opts, timeout: 300 }, cb);
      },
    );

    const started = Date.now();
    const err = await stopContainerAsync('nanoclaw-hung-2').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ killed: true, signal: 'SIGKILL' });
    expect(isRuntimeTimeout(err)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('isRuntimeTimeout', () => {
  it('is true only for errors Node marked as killed', () => {
    expect(isRuntimeTimeout(Object.assign(new Error('x'), { killed: true }))).toBe(true);
    expect(isRuntimeTimeout(Object.assign(new Error('x'), { killed: false }))).toBe(false);
    expect(isRuntimeTimeout(new Error('No such container'))).toBe(false);
    expect(isRuntimeTimeout(null)).toBe(false);
    expect(isRuntimeTimeout('ETIMEDOUT')).toBe(false);
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(log.debug).toHaveBeenCalledWith('Container runtime already running');
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow('Container runtime is required but failed to start');
    expect(log.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('filters ps by the install label so peers are not reaped, with a timeout', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      expect.objectContaining({ timeout: RUNTIME_CLI_TIMEOUT_MS }),
    );
  });

  it('stops orphaned nanoclaw containers', () => {
    // docker ps returns container names, one per line
    mockExecSync.mockReturnValueOnce('nanoclaw-group1-111\nnanoclaw-group2-222\n');
    // stop calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ps + 2 stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group1-111`, {
      stdio: 'pipe',
      timeout: RUNTIME_CLI_TIMEOUT_MS,
    });
    expect(mockExecSync).toHaveBeenNthCalledWith(3, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group2-222`, {
      stdio: 'pipe',
      timeout: RUNTIME_CLI_TIMEOUT_MS,
    });
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'],
    });
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(log.warn).toHaveBeenCalledWith(
      'Failed to clean up orphaned containers',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-a-1', 'nanoclaw-b-2'],
    });
  });
});
