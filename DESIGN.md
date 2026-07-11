# QueueCTL - Architecture and Design Specification

This document details the system design, core lifecycles, execution flows, and technology stack of QueueCTL, broken down function-by-function.

---

## 1. Technology Stack
* **Runtime**: Node.js (v18+).
* **CLI Engine**: `commander` (for command parsing and option routing) and `inquirer` (for interactive Prompts).
* **Concurrency & Storage**: Flat-file JSON (`db.json`) using standard Node `fs` (file system) APIs, controlled via exclusive filesystem lockfiles (`db.lock`) using kernel-level atomic `O_CREAT | O_EXCL` flags.
* **Process Management**: Native Node `child_process` module:
  * `fork` to spawn background workers.
  * `exec` to invoke individual job commands.
  * `spawn` to bridge the dashboard API server and the React Vite development server.
* **OS-Level Signaling**: Standard POSIX signaling (`SIGINT`, `SIGTERM`) combined with Windows console-specific signals (`SIGBREAK`) and shell-based process tree killers (`taskkill /T /F`).

---

## 2. Core Lifecycles and Flows

### A. Job State Lifecycles
```mermaid
stateDiagram-v2
    [*] --> pending : Enqueued (Created)
    pending --> processing : Acquired by Worker (sets worker_pid)
    failed --> processing : Backoff Delay Expired & Acquired
    
    state processing {
        [*] --> Executing : exec(command)
        Executing --> Timeout : Exceeds timeout config
    }
    
    processing --> completed : Command Exits Code 0
    processing --> failed : Command Exits Non-Zero / Timeout (attempts < max_retries)
    processing --> dead : Crash / Failure (attempts >= max_retries)
    
    dead --> pending : dlq retry (attempts reset to 0)
    completed --> [*]
```

---

### B. Concurrency-Safe Database Transaction Flow
```mermaid
sequenceDiagram
    participant Process as Worker/CLI Process
    participant FS as File System (OS Kernel)
    participant Lock as db.lock
    participant DB as db.json

    Process->>FS: openSync("db.lock", "wx")
    alt Lock file already exists (EEXIST)
        FS-->>Process: Error EEXIST
        Process->>Process: Read PID in db.lock
        Process->>FS: isProcessAlive(PID)?
        alt Process is Dead
            Process->>FS: unlinkSync("db.lock") (Self-Heal)
            Process->>FS: Retry lock creation
        else Process is Alive
            Process->>Process: Sleep 100ms & Retry
        end
    else Lock file created successfully
        FS-->>Process: Return File Descriptor
        Process->>FS: readFileSync("db.json")
        Process->>Process: Execute Transaction Logic (fn)
        Process->>FS: writeFileSync("db.json.tmp")
        Process->>FS: renameSync("db.json.tmp", "db.json") (Atomic Commit)
        Process->>FS: unlinkSync("db.lock") (Release Lock)
    end
```

---

### C. Worker Heartbeat and Crash Recovery Flow
```mermaid
flowchart TD
    A[Worker Starts] --> B[Start 1s Background Interval]
    B --> C[Send Heartbeat: last_seen = Date.now()]
    C --> D[Is Job Executing?]
    D -- Yes --> E[Status: 'executing job_id']
    D -- No --> F[Status: 'polling']
    E --> G[Sleep 1s]
    F --> G
    G --> C

    H[Any Active Worker Polls] --> I[Scan Jobs in 'processing' State]
    I --> J{Is worker_pid alive?}
    J -- Yes: now - last_seen < 10s --> K[Do Nothing]
    J -- No: missing or silent > 10s --> L[Reclaim Job]
    L --> M[Increment attempts + Clear worker_pid]
    M --> N{attempts >= max_retries?}
    N -- Yes --> O[Set state: 'dead']
    N -- No --> P[Set state: 'failed' + Set run_at with backoff]
    O --> Q[Delete Stale Worker from activeWorkers]
    P --> Q
```

---

### D. Database Schema & Relationships (Entity-Relationship Diagram)
```mermaid
erDiagram
    CONFIG {
        int max_retries
        int backoff_base
        int timeout
    }
    
    JOB {
        string id PK
        string command
        string state "pending | processing | completed | failed | dead"
        int attempts
        int max_retries
        string created_at
        string updated_at
        string run_at
        int worker_pid FK "Refers to ActiveWorker PID"
    }
    
    ACTIVE_WORKER {
        int pid PK
        string status "polling | executing job_id"
        long last_seen "timestamp"
        boolean shutdown_requested
    }

    ACTIVE_WORKER ||--o| JOB : "executes"
    CONFIG ||--o{ JOB : "governs retry / timeout rules"
```

---

### E. Function Call Flow Diagram
```mermaid
flowchart TD
    subgraph CLI_Layer [CLI Controller: bin/queuectl.js]
        enqueueCMD[enqueue command]
        startCMD[worker start command]
        stopCMD[worker stop command]
        statusCMD[status command]
        dlqCMD[dlq retry command]
        readActivePids[readActivePids]
    end

    subgraph Queue_Layer [Queue Management: src/queue.js]
        enqueueJob[enqueueJob]
        getStats[getStats]
        retryDeadJob[retryDeadJob]
        workerHeartbeat[workerHeartbeat]
        workerDeregister[workerDeregister]
    end

    subgraph Worker_Layer [Worker Processing: src/worker.js]
        runWorker[runWorker]
        poll[poll]
        execCMD[exec child process]
        cleanupAndExit[cleanupAndExit]
    end

    subgraph DB_Layer [Database Transaction: src/db.js]
        transaction[transaction]
        acquireLock[acquireLock]
        releaseLock[releaseLock]
        writeDbRaw[writeDbRaw]
        isProcessAlive[isProcessAlive]
    end

    %% CLI Invocation Pathways
    enqueueCMD --> enqueueJob
    startCMD --> readActivePids
    startCMD --> runWorker
    stopCMD --> readActivePids
    stopCMD --> getStats
    stopCMD --> isProcessAlive
    statusCMD --> getStats
    dlqCMD --> retryDeadJob

    %% Worker Invocation Pathways
    runWorker --> poll
    runWorker --> workerHeartbeat
    poll --> transaction
    poll --> execCMD
    poll --> cleanupAndExit
    cleanupAndExit --> workerDeregister

    %% Queue & DB Invocation Pathways
    enqueueJob --> transaction
    getStats --> transaction
    retryDeadJob --> transaction
    workerHeartbeat --> transaction
    workerDeregister --> transaction
    
    %% Transaction Lifecycle Internals
    transaction --> acquireLock
    transaction --> writeDbRaw
    transaction --> releaseLock
    acquireLock --> isProcessAlive
```


