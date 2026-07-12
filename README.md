# QueueCTL - CLI Background Job Queue System

`queuectl` is a production-grade, minimal CLI-based background job queue system written in **Node.js**. It manages background jobs with multiple parallel worker processes, handles job retries using configurable exponential backoff, manages a Dead Letter Queue (DLQ) for permanently failed jobs, and guarantees persistence across restarts.

Demo Link: [Watch Demo](https://drive.google.com/file/d/1EPc0nwJgz0PDzD5120DiMSshoFBfhbMT/view?usp=sharing)

## Features
- **Job Enqueuing & Future Scheduling**: Enqueue shell commands to execute immediately or schedule them in the future using the `--run-at` option (accepts relative delays in seconds or absolute ISO timestamps).
- **Concurrently Processing Workers**: Start one or multiple worker processes that poll the queue and run jobs in parallel without overlapping/duplicate execution.
- **Job Execution Timeouts**: Prevent workers from hanging indefinitely on frozen/long-running processes by configuring execution timeouts (kills the process tree on Windows using `taskkill` or process on other platforms).
- **Atomic Concurrency Control**: Custom transactional database engine utilizing lockfiles to guarantee concurrency safety, featuring self-healing stale lock resolution.
- **Graceful Shutdown**: Workers finish their current task before shutting down when receiving `SIGINT`/`SIGTERM` (POSIX), `SIGBREAK` (Windows), or when flagged via database-driven shutdown requests.
- **Automatic Retries & Exponential Backoff**: Automatically schedules job retries with backoff delays calculated as:
  $$\text{delay} = \text{base}^{\text{attempts}} \text{ seconds}$$
- **Crash Recovery & Reclaiming**: Automatically detects worker crashes (via 10s heartbeat expirations), reclaims orphaned `processing` jobs, increments attempts, and schedules them for retry with backoff.
- **Dead Letter Queue (DLQ)**: Jobs exceeding the maximum retry limit are put into the DLQ (`dead` state) and can be listed or re-queued manually.
- **Flexible Configuration**: Set global limits like `max-retries`, `backoff-base`, and execution `timeout` using the CLI or the React dashboard.
- **React Dashboard**: Visual interface for managing jobs, active workers, and setting configurations dynamically.

---

## Architecture Overview

### Project Directory Structure
```text
├── bin/
│   └── queuectl.js        # CLI Command Definition Entrypoint
├── src/
│   ├── db.js              # Atomic Concurrency-Safe Transactional DB Engine
│   ├── queue.js           # Core Queue state logic, heartbeats, and statistics
│   ├── worker.js          # Foreground worker execution loops, timeout, and recovery
│   ├── config.js          # Configuration helpers
│   └── server.js          # Express API server for the Visual dashboard
├── dashboard/             # React visual dashboard interface (Vite)
├── tests/                 # Integration and E2E verification test suite
├── DECISIONS.md           # Architecture Decisions & Internship Answers
├── design.md              # Graphics-rich Flow Lifecycles & Call Diagrams
└── README.md              # Core Setup, Command Usage, and System Guides
```

### 1. Concurrency-Safe Persistent Storage (`src/db.js`)
All job, worker, and configuration states are persisted in a local JSON database file (`db.json`) inside the user's application data directory.
To prevent concurrent worker threads from writing at the same time or double-acquiring a job, `src/db.js` implemented a custom filesystem-based transactional lock using exclusive file descriptors (`fs.openSync` with the `'wx'` flag). If a process holds the lock, other workers wait and retry.

### 2. Job Lifecycle State Transitions
```
   [Enqueue] ──> pending ──> [Acquired by Worker] ──> processing
                                                          │
                    ┌─────────────────────────────────────┴─────┐
                    ▼                                           ▼
               (Succeeds)                                   (Fails/Timeout)
                    │                                           │
                    ▼                                           ▼
                completed                       [attempts < max_retries] ──> failed (schedules retry)
                                                                │
                                                                ▼
                                                [attempts >= max_retries] ──> dead (DLQ)
```

### 3. Worker Process Coordination (`src/worker.js`)
- **Heartbeats**: Active workers run a background interval timer updating `db.json` every second with their status (`polling` or `executing <job_id>`). This runs independently of the job execution subprocess to protect long-running tasks.
- **Acquisition**: When a worker acquires an eligible job (state `pending` or `failed` with `run_at <= now`), it atomically sets the state to `processing` and stores its own Process ID as `worker_pid` on the job object.
- **Orphaned Job Recovery**: During every poll transaction, active workers check for jobs in the `processing` state whose associated `worker_pid` has not updated its heartbeat in 10 seconds. The worker automatically recovers the job (incrementing attempts and resetting state) and deletes the crashed worker's PID record from `db.activeWorkers`.
- **Automatic Pruning**: Active workers clean up any idle crashed worker records from `db.activeWorkers` if they have been silent for more than 30 seconds.
- **Execution & Timeout**: Jobs run inside a spawned shell (`child_process.exec`). If execution exceeds the configured timeout, the worker terminates the process tree (`taskkill` on Windows, `.kill()` on POSIX) and transitions the job to `failed`.

---

## Setup Instructions

1. Clone or copy this repository to your local workspace.
2. Configure your environment variables in `.env` (optional, defaults to port `3001`):
   - **Root `.env`**: Define `PORT=3001` for the backend API server.
   - **Dashboard `.env`**: Define `VITE_API_BASE=http://localhost:3001/api` for the frontend.
3. Link the package globally or use it with direct paths:
   ```bash
   npm install
   npm link
   ```
   *Alternatively, run commands directly using `node bin/queuectl.js`.*

---

## Usage Examples

### 1. Manage Configurations
Set the maximum retries, backoff base, or execution timeouts.
```bash
$ queuectl config set max-retries 3
Configuration updated successfully:
{
  "max_retries": 3,
  "backoff_base": 2,
  "timeout": 30
}

$ queuectl config set backoff-base 3
Configuration updated successfully:
{
  "max_retries": 3,
  "backoff_base": 3,
  "timeout": 30
}

$ queuectl config set timeout 45
Configuration updated successfully:
{
  "max_retries": 3,
  "backoff_base": 3,
  "timeout": 45
}
```

### 2. Enqueuing Jobs
Enqueue jobs by passing raw commands:
```bash
$ queuectl enqueue "echo 'Hello from QueueCTL!'"
Enqueued job successfully:
{
  "id": "job_sfr67ghew_1783610195427",
  "command": "echo 'Hello from QueueCTL!'",
  "state": "pending",
  "attempts": 0,
  "max_retries": 3,
  "created_at": "2026-07-09T15:16:35.426Z",
  "updated_at": "2026-07-09T15:16:35.426Z",
  "run_at": "2026-07-09T15:16:35.426Z"
}
```

Enqueue jobs with custom properties (such as custom IDs) using a JSON string:
```bash
$ queuectl enqueue '{"id":"job1","command":"sleep 2"}'
Enqueued job successfully:
{
  "id": "job1",
  "command": "sleep 2",
  "state": "pending",
  "attempts": 0,
  "max_retries": 3,
  "created_at": "2026-07-11T14:26:40.435Z",
  "updated_at": "2026-07-11T14:26:40.435Z",
  "run_at": "2026-07-11T14:26:40.435Z"
}
```

Enqueue scheduled jobs to run in the future:
```bash
$ queuectl enqueue "echo 'Hello scheduled!'" --run-at 10
Enqueued job successfully:
{
  "id": "job_vq2y89k2j_1783610212048",
  "command": "echo 'Hello scheduled!'",
  "state": "pending",
  "attempts": 0,
  "max_retries": 3,
  "created_at": "2026-07-09T15:16:52.047Z",
  "updated_at": "2026-07-09T15:16:52.047Z",
  "run_at": "2026-07-09T15:17:02.047Z"
}
```


### 3. Running Workers
Start concurrent worker processes to poll and process the queue.

* **Single Worker in the Foreground (shows stdout/stderr of executing jobs)**:
  ```bash
  $ queuectl worker start
  Starting worker in the foreground (PID: 12345)...
  [Worker 12345] Started job processing loop.
  [Worker 12345] Executing job job_ypfrc3zcn_1783780000449: "echo 'Hello from QueueCTL!'"
  Hello from QueueCTL!
  [Worker 12345] Job job_ypfrc3zcn_1783780000449 completed successfully.
  ```

* **Multiple Workers (forked in the background)**:
  ```bash
  $ queuectl worker start --count 2
  Starting 2 worker(s)...
  Started workers with PIDs: 12456, 14890
  ```

Check the status of the queue and list of active workers:
```bash
$ queuectl status
=== Queue Status ===
Pending:    1
Processing: 0
Completed:  2
Failed:     0
Dead (DLQ): 1

=== Active Workers ===
Count: 2
- PID 12456: polling
- PID 14890: polling
```

To stop all active workers gracefully:
```bash
$ queuectl worker stop
Stopping workers gracefully...
Sending SIGTERM to worker 12456...
Sending SIGTERM to worker 14890...
Stop signals sent to all active workers.
```

### 4. Running the Dashboard UI
Start the backend dashboard API server:
```bash
$ queuectl dashboard
Dashboard API server running on port 3001
```
Start the web dashboard frontend interface (runs Vite dev server):
```bash
$ queuectl ui
Starting frontend dashboard development server (npm run dev)...
  VITE v5.2.0  ready in 320 ms
  ➜  Local:   http://localhost:5173/
```

### 5. Listing Jobs
List jobs by their state (e.g. `pending`, `processing`, `completed`, `failed`, `dead`).

* **Human-Readable Output (Default)**:
  ```bash
  $ queuectl list --state pending
  === Jobs List ===
  - ID: job_sfr67ghew_1783610195427
    Command:  "echo 'Hello from QueueCTL!'"
    State:    pending
    Attempts: 0/3
    Created:  2026-07-09T15:16:35.426Z
  --------------------------------------------------
  ```

* **JSON Output (`--json`)**:
  ```bash
  $ queuectl list --state pending --json
  [
    {
      "id": "job_sfr67ghew_1783610195427",
      "command": "echo 'Hello from QueueCTL!'",
      "state": "pending",
      "attempts": 0,
      "max_retries": 3,
      "created_at": "2026-07-09T15:16:35.426Z",
      "updated_at": "2026-07-09T15:16:35.426Z",
      "run_at": "2026-07-09T15:16:35.426Z"
    }
  ]
  ```

### 6. Managing the Dead Letter Queue (DLQ)
List all dead jobs:
```bash
$ queuectl dlq list
[
  {
    "id": "job_83gy949n6_1783610196146",
    "command": "invalidcommandhere123",
    "state": "dead",
    "attempts": 2,
    "max_retries": 2,
    "created_at": "2026-07-09T15:16:36.144Z",
    "updated_at": "2026-07-09T15:16:42.236Z",
    "run_at": "2026-07-09T15:16:41.318Z"
  }
]
```
Retry a job from the DLQ (resets attempts and returns it to `pending` status):
```bash
$ queuectl dlq retry job_83gy949n6_1783610196146
Job job_83gy949n6_1783610196146 successfully reset and returned to pending state.
```

---

## Testing & Flow Verification

Two comprehensive integration test scripts are included in the `tests/` directory:

1. **E2E & Timeout Verification Test (`tests/test_flow.js`)**:
   - Cleans the database, configures parameters, enqueues jobs (success, failing, JSON), spawns 2 background workers, checks statuses, stops workers, checks the DLQ, and resets a DLQ job.
   - **Timeout Check**: Enqueues a long-running job under a 2-second timeout, verifies that the worker terminates it successfully before completion, and resets configuration back to default.
   - **Restart Persistence Check**: Enqueues jobs while offline, starts a fresh worker (simulating process restart), and verifies that the new worker successfully reads from disk and processes all offline-enqueued jobs.
   - Run via: `node tests/test_flow.js` or `npm test`.

2. **Scheduling Integration Test (`tests/test_run_at.js`)**:
   - Enqueues a job scheduled 3 seconds in the future, starts a worker, asserts that the job is ignored for the first second, and validates that it runs and completes successfully once the 3-second delay has expired.
   - Run via: `node tests/test_run_at.js`.

Run the test suite using:
```bash
npm test
```

---

## Assumptions & Trade-offs

### Assumptions
1. **Single-Host Topology**: The queue is designed to run on a single host machine. Concurrency control relies on local filesystem locks (`db.lock`), assuming all worker processes and CLI clients share the same directory path.
2. **Execution Trust**: The enqueued job commands are assumed to be trusted. Commands are executed directly inside a shell environment (`child_process.exec`), so the host system must have any requested CLI tools/binaries installed.
3. **Heartbeat Tolerances**: The 10-second window is assumed to be an acceptable delay for detecting and filtering out abruptly crashed workers from the active workers list.
4. **Environment Availability**: On Windows, it is assumed that `taskkill.exe` is available on the system path to cleanly terminate grandchildren/sub-processes when a timeout is reached.

### Trade-offs
1. **Zero External Dependencies vs. Scalability**: We chose a local filesystem-based lock (`wx` descriptor flag) and JSON file storage over Redis or Postgres. This makes the system incredibly easy to set up with zero dependencies, but limits scalability to a single machine.
2. **In-Memory JSON Serialization**: The database (`db.json`) is fully read, parsed, and rewritten on every state transaction. This is fast and simple for small-to-medium queues, but would become a performance bottleneck if the database grew to millions of jobs.
3. **Windows Graceful Stops**: Since Windows does not support POSIX signals (`SIGTERM`), we propagation-route remote stops using `SIGBREAK` signals on Windows, and fall back to database-driven `shutdown_requested` flags in the worker polling loops. This guarantees graceful exits on Windows consoles while maintaining standard POSIX signaling on Linux/macOS.
4. **Local Console Outputs**: Job stdout and stderr are printed directly to the worker's console rather than stored in the database. This keeps the database file lightweight but requires looking at worker terminal logs to see job printouts.
