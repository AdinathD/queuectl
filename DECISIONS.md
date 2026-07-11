# QueueCTL - Architecture Decisions

This document outlines the key architectural decisions, recovery mechanics, and design trade-offs made in the QueueCTL background job system.

---

### Question 1: Which exact line(s) prevent two workers from claiming the same job, and why is that operation atomic across separate OS processes?
* **Exact Line(s)**: 
  * [src/db.js:L32](file:///c:/Adinath/flam/antig/src/db.js#L32): `const fd = fs.openSync(LOCK_FILE, 'wx');` (Acquires exclusive write-lock).
  * [src/worker.js:L114-L125](file:///c:/Adinath/flam/antig/src/worker.js#L114-L125) (Queries and flags the eligible job inside the transaction block).
* **Why it is atomic**:
  * **OS-Level Lock**: Node's `'wx'` flag maps to the kernel's atomic `O_CREAT | O_EXCL` flags. The operating system kernel guarantees that if multiple processes try to create `db.lock` simultaneously, only one succeeds and receives a file descriptor; the rest fail with `EEXIST` and must wait.
  * **Mutual Exclusion**: While a worker holds this lock, no other process can read or write `db.json`. Thus, the step finding the job and marking it as `processing` runs with absolute mutual exclusion, preventing any duplicate claims.

---

### Question 2: A worker is SIGKILL ed halfway through a job. Walk through, step by step, what state the job is in and how it eventually runs again. What is the worst-case delay before recovery?
* **Step-by-Step Recovery Lifecycle**:
  1. **Worker Dies**: The worker is terminated instantly. The job is left in `db.json` with `state: "processing"` and `worker_pid: <PID>`.
  2. **Heartbeats Stop**: The crashed worker's background heartbeat loop ceases. Its record under `db.activeWorkers[PID].last_seen` stops updating.
  3. **Poll Verification**: When any healthy worker runs its next polling transaction, it loops through all `processing` jobs.
  4. **Staleness Detection**: It checks the `last_seen` timestamp of the job's `worker_pid`. Since the worker died, `Date.now() - worker.last_seen > 10000` evaluates to `true` (over 10 seconds of silence).
  5. **State Reclaim**: The polling worker marks the job's `worker_pid` as deleted from `db.activeWorkers`, increments `attempts` by 1, and clears the job's `worker_pid` tag.
  6. **Rescheduling**: If `attempts < max_retries`, the job state transitions to `failed` with a future `run_at` time (based on exponential backoff). Once this backoff delay expires, it is picked up and executed by an active worker. If attempts are exhausted, it moves to `dead` (DLQ).
* **Worst-Case Delay**: **11 seconds** (10 seconds for the heartbeat to expire + 1 second for the next worker polling cycle to execute and write the recovery transaction to disk).

---

### Question 3: Does dlq retry reset attempts ? Why is that the right call?
* **Answer**: Yes, the `dlq retry` command resets `attempts` back to `0`.
* **Why it is the right call**:
  * Landing in the DLQ (`dead` state) implies the job has completely exhausted all of its automated retries.
  * When a developer manually retries a DLQ job (usually after correcting a typo, fixing a downstream API, or resolving environmental issues), they expect the job to behave as a **completely fresh execution attempt**.
  * If `attempts` were not reset, the job would begin with `attempts = max_retries`. Upon its very first failure post-retry, the job would instantly be marked as `dead` again, completely bypassing the configured retry and backoff mechanisms. Setting `attempts = 0` guarantees the job receives its full, fresh lifecycle.

---

### Question 4: What designs did you consider and reject for worker stop (cross-process signaling), and why?
* **Design 1: IPC Control Sockets (Unix domain sockets / TCP sockets)**:
  * *Why Considered*: Sockets allow direct, reliable connection channels between the CLI and active workers to transmit stop requests.
  * *Rejected because*: Unix domain sockets have inconsistent and non-standard support across Windows console runtimes. TCP sockets require choosing, binding, and managing specific network ports, leading to port collision conflicts and triggering firewall prompt alerts.
* **Design 2: Pure Database Command Polling Table**:
  * *Why Considered*: Workers could query a central command table flag (e.g. `shutdown_requested`) in the database during their polling loops.
  * *Rejected because*: Relying *solely* on database polling introduces up to a 1-second response latency (the polling interval) and creates high file lock contention on `db.json` when multiple workers are running.
* **Design 3: Direct OS Process Tree/Shell Lookup Only**:
  * *Why Considered*: CLI could list running OS processes and search for worker executable files to find active worker processes.
  * *Rejected because*: Listing processes via utility commands (like `tasklist` or `ps`) to find active workers running the CLI program requires platform-specific parsing of CLI names, which is fragile and slow.
* **Final Chosen Solution (Hybrid Discovery & Signaling)**:
  * **Discovery**: We read Process IDs from a local cache file (`workers.pids`), filtering out dead processes via `isProcessAlive(pid)`. In case this cache file is deleted or workers are launched manually (e.g. via `node src/worker.js`), we fallback to scanning `db.json` for active heartbeats in the last 10 seconds.
  * **Signaling**: We use native OS signals (`SIGBREAK` on Windows, `SIGTERM` on POSIX) for instant, zero-latency kernel-level graceful stop propagation.
  * **Failsafe Fallback Flag**: Since Node.js does not support cross-process signal propagation on Windows in some configurations, we also write `shutdown_requested = true` to `db.activeWorkers[pid]` in `db.json`. Workers intercept this flag during their 1-second polling transaction and gracefully shut down as a fail-safe backup.

---

### Question 5: If priorities were added tomorrow (high-priority jobs jump the queue), which parts of your design survive unchanged and which break?
* **What Survives Unchanged**:
  * **Database Locking and Transactions (`src/db.js`)**: The exclusive transaction locking mechanics, lock-healing, and rename-on-write retry loops remain completely unchanged.
  * **Worker Execution & Timeout (`src/worker.js`)**: Subprocess invocation, execution monitoring, and process tree killing are priority-independent.
  * **Crash Recovery & Heartbeats (`src/queue.js`)**: Monitoring heartbeat states and reclaiming processing jobs from crashed workers remain identical.
* **What Breaks & Must Be Replaced**:
  * **Job Selection Query**: The FIFO query in `src/worker.js` that selects the first eligible job using `.find()` breaks. It must be replaced to first filter eligible jobs, sort them by priority (e.g. `high` > `medium` > `low`), and select the highest priority:
    ```javascript
    const eligibleJob = db.jobs
      .filter(j => (j.state === 'pending' || j.state === 'failed') && (!j.run_at || new Date(j.run_at) <= now))
      .sort((a, b) => b.priority - a.priority || new Date(a.created_at) - new Date(b.created_at))[0];
    ```
  * **CLI Enqueuer**: The `enqueue` command definition in `bin/queuectl.js` breaks as it must be modified to support a new `--priority` option and write it to the enqueued job object.
