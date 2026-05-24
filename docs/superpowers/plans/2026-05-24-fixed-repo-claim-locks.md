# Fixed Repo Claim Locks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PR2 claim-time path locking and claim response metadata for fixed repo agents, stacked on PR1.

**Architecture:** Store active fixed repo path ownership in a server-side lock table. `TaskService.ClaimTask` claims a queued task and acquires a path lock before broadcasting dispatch; terminal task transitions release the lock. `ClaimTaskByRuntime` includes the locked path and VCS metadata in the task payload for a later daemon PR to consume.

**Tech Stack:** Go 1.26, sqlc/pgx, PostgreSQL migrations, Chi handler tests.

---

## Scope

Included:

- `agent_fixed_repo_locks` table with active-lock uniqueness.
- sqlc queries to acquire, read, release, and undo a dispatched claim when no fixed path is available.
- `TaskService.ClaimTask` lock acquisition for fixed repo agents.
- lock release on complete/fail/cancel and shared failed-task handling.
- claim response fields: `fixed_repo_mode`, `fixed_repo_path`, `fixed_repo_vcs_type`, `fixed_repo_cleanup_script`.
- handler/service tests for locking, no-capacity behavior, release, and claim metadata.

Excluded:

- daemon execution in the fixed path.
- CLI checkout rejection.
- UI.
- cleanup script execution.

## File Structure

- Create `server/migrations/109_agent_fixed_repo_locks.up.sql`: lock table and unique indexes.
- Create `server/migrations/109_agent_fixed_repo_locks.down.sql`: drop lock table.
- Modify `server/pkg/db/queries/agent.sql`: fixed repo lock queries plus `UnclaimDispatchedTask`.
- Regenerate `server/pkg/db/generated/models.go` and `server/pkg/db/generated/agent.sql.go`.
- Modify `server/internal/service/task.go`: acquire/release locks in lifecycle paths.
- Modify `server/internal/handler/agent.go`: add response fields.
- Modify `server/internal/handler/daemon.go`: populate claim response metadata.
- Modify `server/internal/handler/daemon_test.go`: add claim response integration test.
- Modify `server/internal/handler/agent_test.go`: add service-level lock lifecycle tests using the handler fixture.

## Task 1: Failing Lock Tests

**Files:**
- Modify: `server/internal/handler/agent_test.go`
- Modify: `server/internal/handler/daemon_test.go`

- [ ] **Step 1: Add service lock lifecycle tests**

Append to `server/internal/handler/agent_test.go`:

```go
func createFixedRepoAgentForClaimTest(t *testing.T, name string, maxTasks int) (string, string) {
	t.Helper()
	ctx := context.Background()
	runtimeID := createHandlerTestLocalRuntime(t, name+"-runtime")

	var agentID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent (
			workspace_id, name, description, runtime_mode, runtime_config,
			runtime_id, visibility, max_concurrent_tasks, owner_id,
			instructions, custom_env, custom_args,
			fixed_repo_enabled, fixed_repo_paths, fixed_repo_vcs_type, fixed_repo_cleanup_script
		)
		VALUES ($1, $2, '', 'local', '{}'::jsonb, $3, 'private', $4, $5,
			'', '{}'::jsonb, '[]'::jsonb, true, '["/fixed/one"]'::jsonb, 'git', '/fixed/one/cleanup.sh')
		RETURNING id
	`, testWorkspaceID, name, runtimeID, maxTasks, testUserID).Scan(&agentID); err != nil {
		t.Fatalf("create fixed repo agent: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent WHERE id = $1`, agentID)
	})
	return agentID, runtimeID
}

func createQueuedTaskForAgent(t *testing.T, agentID, runtimeID string, priority int) string {
	t.Helper()
	var taskID string
	if err := testPool.QueryRow(context.Background(), `
		INSERT INTO agent_task_queue (agent_id, runtime_id, status, priority)
		VALUES ($1, $2, 'queued', $3)
		RETURNING id
	`, agentID, runtimeID, priority).Scan(&taskID); err != nil {
		t.Fatalf("create queued task: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE id = $1`, taskID)
	})
	return taskID
}

func activeFixedRepoLockCount(t *testing.T, agentID string) int {
	t.Helper()
	var count int
	if err := testPool.QueryRow(context.Background(), `
		SELECT count(*) FROM agent_fixed_repo_locks
		WHERE agent_id = $1 AND released_at IS NULL
	`, agentID).Scan(&count); err != nil {
		t.Fatalf("count fixed repo locks: %v", err)
	}
	return count
}

func TestFixedRepoClaim_AcquiresOnePathAndLeavesSecondTaskQueued(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	agentID, runtimeID := createFixedRepoAgentForClaimTest(t, "fixed-repo-claim-lock", 2)
	firstTaskID := createQueuedTaskForAgent(t, agentID, runtimeID, 10)
	secondTaskID := createQueuedTaskForAgent(t, agentID, runtimeID, 9)

	first, err := testHandler.TaskService.ClaimTask(ctx, parseUUID(agentID))
	if err != nil {
		t.Fatalf("first ClaimTask: %v", err)
	}
	if first == nil || uuidToString(first.ID) != firstTaskID {
		t.Fatalf("first claim = %+v, want task %s", first, firstTaskID)
	}

	second, err := testHandler.TaskService.ClaimTask(ctx, parseUUID(agentID))
	if err != nil {
		t.Fatalf("second ClaimTask: %v", err)
	}
	if second != nil {
		t.Fatalf("expected no second claim while fixed repo path is locked, got %+v", second)
	}
	if got := activeFixedRepoLockCount(t, agentID); got != 1 {
		t.Fatalf("active lock count = %d, want 1", got)
	}

	var secondStatus string
	if err := testPool.QueryRow(ctx, `SELECT status FROM agent_task_queue WHERE id = $1`, secondTaskID).Scan(&secondStatus); err != nil {
		t.Fatalf("load second task status: %v", err)
	}
	if secondStatus != "queued" {
		t.Fatalf("second task status = %q, want queued", secondStatus)
	}
}

func TestFixedRepoClaim_ReleasesPathOnComplete(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	agentID, runtimeID := createFixedRepoAgentForClaimTest(t, "fixed-repo-release", 2)
	firstTaskID := createQueuedTaskForAgent(t, agentID, runtimeID, 10)
	secondTaskID := createQueuedTaskForAgent(t, agentID, runtimeID, 9)

	first, err := testHandler.TaskService.ClaimTask(ctx, parseUUID(agentID))
	if err != nil {
		t.Fatalf("ClaimTask: %v", err)
	}
	if first == nil || uuidToString(first.ID) != firstTaskID {
		t.Fatalf("first claim = %+v, want task %s", first, firstTaskID)
	}
	if _, err := testHandler.TaskService.StartTask(ctx, first.ID); err != nil {
		t.Fatalf("StartTask: %v", err)
	}
	if _, err := testHandler.TaskService.CompleteTask(ctx, first.ID, []byte(`{"output":"done"}`), "session-1", "/fixed/one"); err != nil {
		t.Fatalf("CompleteTask: %v", err)
	}
	if got := activeFixedRepoLockCount(t, agentID); got != 0 {
		t.Fatalf("active lock count after complete = %d, want 0", got)
	}

	second, err := testHandler.TaskService.ClaimTask(ctx, parseUUID(agentID))
	if err != nil {
		t.Fatalf("second ClaimTask after release: %v", err)
	}
	if second == nil || uuidToString(second.ID) != secondTaskID {
		t.Fatalf("second claim = %+v, want task %s", second, secondTaskID)
	}
}
```

- [ ] **Step 2: Add claim metadata integration test**

Append to `server/internal/handler/daemon_test.go`:

```go
func TestClaimTaskByRuntime_FixedRepoMetadata(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	runtimeID := createHandlerTestLocalRuntime(t, "fixed-repo-claim-response-runtime")

	var agentID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent (
			workspace_id, name, description, runtime_mode, runtime_config,
			runtime_id, visibility, max_concurrent_tasks, owner_id,
			instructions, custom_env, custom_args,
			fixed_repo_enabled, fixed_repo_paths, fixed_repo_vcs_type, fixed_repo_cleanup_script
		)
		VALUES ($1, 'fixed-repo-claim-response-agent', '', 'local', '{}'::jsonb, $2, 'private', 1, $3,
			'', '{}'::jsonb, '[]'::jsonb, true, '["/fixed/claim-response"]'::jsonb, 'perforce', '/fixed/claim-response/cleanup.sh')
		RETURNING id
	`, testWorkspaceID, runtimeID, testUserID).Scan(&agentID); err != nil {
		t.Fatalf("create agent: %v", err)
	}
	t.Cleanup(func() { testPool.Exec(ctx, `DELETE FROM agent WHERE id = $1`, agentID) })
	createQueuedTaskForAgent(t, agentID, runtimeID, 10)

	req := newDaemonRequest(http.MethodPost, "/api/runtimes/"+runtimeID+"/tasks/claim", nil, testWorkspaceID, "fixed-repo-daemon")
	req = withURLParam(req, "runtimeId", runtimeID)
	w := httptest.NewRecorder()
	testHandler.ClaimTaskByRuntime(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("ClaimTaskByRuntime: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var body struct {
		Task *AgentTaskResponse `json:"task"`
	}
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode claim response: %v", err)
	}
	if body.Task == nil {
		t.Fatal("expected claimed task")
	}
	if !body.Task.FixedRepoMode {
		t.Fatalf("expected fixed_repo_mode=true, got %+v", body.Task)
	}
	if body.Task.FixedRepoPath != "/fixed/claim-response" {
		t.Fatalf("fixed_repo_path = %q", body.Task.FixedRepoPath)
	}
	if body.Task.FixedRepoVcsType != "perforce" {
		t.Fatalf("fixed_repo_vcs_type = %q", body.Task.FixedRepoVcsType)
	}
	if body.Task.FixedRepoCleanupScript == nil || *body.Task.FixedRepoCleanupScript != "/fixed/claim-response/cleanup.sh" {
		t.Fatalf("fixed_repo_cleanup_script = %#v", body.Task.FixedRepoCleanupScript)
	}
}
```

- [ ] **Step 3: Run tests and verify RED**

Run:

```bash
cd server
set -a; . ../.env.worktree; set +a
go test ./internal/handler -run 'TestFixedRepoClaim|TestClaimTaskByRuntime_FixedRepoMetadata' -count=1
```

Expected: compile failure for missing `agent_fixed_repo_locks` table references in tests or missing `AgentTaskResponse.FixedRepoMode` fields, before implementation.

## Task 2: Lock Schema And sqlc Queries

**Files:**
- Create: `server/migrations/109_agent_fixed_repo_locks.up.sql`
- Create: `server/migrations/109_agent_fixed_repo_locks.down.sql`
- Modify: `server/pkg/db/queries/agent.sql`
- Generated: `server/pkg/db/generated/models.go`
- Generated: `server/pkg/db/generated/agent.sql.go`

- [ ] **Step 1: Add lock migration**

`server/migrations/109_agent_fixed_repo_locks.up.sql`:

```sql
CREATE TABLE agent_fixed_repo_locks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    task_id UUID NOT NULL REFERENCES agent_task_queue(id) ON DELETE CASCADE,
    runtime_id UUID NOT NULL REFERENCES agent_runtime(id) ON DELETE CASCADE,
    locked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX agent_fixed_repo_locks_active_path_unique
    ON agent_fixed_repo_locks(agent_id, path)
    WHERE released_at IS NULL;

CREATE UNIQUE INDEX agent_fixed_repo_locks_active_task_unique
    ON agent_fixed_repo_locks(task_id)
    WHERE released_at IS NULL;

CREATE INDEX agent_fixed_repo_locks_task_idx
    ON agent_fixed_repo_locks(task_id);
```

`server/migrations/109_agent_fixed_repo_locks.down.sql`:

```sql
DROP TABLE IF EXISTS agent_fixed_repo_locks;
```

- [ ] **Step 2: Add sqlc queries**

Append to `server/pkg/db/queries/agent.sql`:

```sql
-- name: AcquireFixedRepoLockForTask :one
WITH existing AS (
    SELECT id, agent_id, path, task_id, runtime_id, locked_at, released_at
    FROM agent_fixed_repo_locks
    WHERE task_id = @task_id AND released_at IS NULL
),
candidate AS (
    SELECT p.path
    FROM agent a
    CROSS JOIN LATERAL jsonb_array_elements_text(a.fixed_repo_paths) WITH ORDINALITY AS p(path, ord)
    WHERE a.id = @agent_id
      AND a.fixed_repo_enabled = TRUE
      AND NOT EXISTS (
          SELECT 1 FROM agent_fixed_repo_locks l
          WHERE l.agent_id = a.id
            AND l.path = p.path
            AND l.released_at IS NULL
      )
    ORDER BY p.ord
    LIMIT 1
),
inserted AS (
    INSERT INTO agent_fixed_repo_locks (agent_id, path, task_id, runtime_id)
    SELECT @agent_id, path, @task_id, @runtime_id FROM candidate
    ON CONFLICT DO NOTHING
    RETURNING id, agent_id, path, task_id, runtime_id, locked_at, released_at
)
SELECT * FROM existing
UNION ALL
SELECT * FROM inserted
LIMIT 1;

-- name: GetActiveFixedRepoLockForTask :one
SELECT
    l.id,
    l.agent_id,
    l.path,
    l.task_id,
    l.runtime_id,
    l.locked_at,
    l.released_at,
    a.fixed_repo_vcs_type,
    a.fixed_repo_cleanup_script
FROM agent_fixed_repo_locks l
JOIN agent a ON a.id = l.agent_id
WHERE l.task_id = $1 AND l.released_at IS NULL
LIMIT 1;

-- name: ReleaseFixedRepoLockForTask :exec
UPDATE agent_fixed_repo_locks
SET released_at = now()
WHERE task_id = $1 AND released_at IS NULL;

-- name: UnclaimDispatchedTask :one
UPDATE agent_task_queue
SET status = 'queued', dispatched_at = NULL
WHERE id = $1 AND status = 'dispatched'
RETURNING *;
```

- [ ] **Step 3: Regenerate sqlc**

Run:

```bash
cd server
go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 generate
```

Expected: generated `AgentFixedRepoLock` model exists and query methods compile.

## Task 3: Claim Lock Lifecycle

**Files:**
- Modify: `server/internal/service/task.go`

- [ ] **Step 1: Add helper methods**

Add helper methods near `ClaimTask`:

```go
func (s *TaskService) releaseFixedRepoLockForTask(ctx context.Context, q *db.Queries, task db.AgentTaskQueue) {
	if err := q.ReleaseFixedRepoLockForTask(ctx, task.ID); err != nil {
		slog.Warn("release fixed repo lock failed",
			"task_id", util.UUIDToString(task.ID),
			"agent_id", util.UUIDToString(task.AgentID),
			"error", err,
		)
	}
}

func (s *TaskService) claimTaskWithFixedRepoLock(ctx context.Context, q *db.Queries, agent db.Agent) (*db.AgentTaskQueue, error) {
	task, err := q.ClaimAgentTask(ctx, agent.ID)
	if err != nil {
		return nil, err
	}
	if !agent.FixedRepoEnabled {
		return &task, nil
	}
	if _, err := q.AcquireFixedRepoLockForTask(ctx, db.AcquireFixedRepoLockForTaskParams{
		AgentID:   agent.ID,
		TaskID:    task.ID,
		RuntimeID: task.RuntimeID,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			if _, resetErr := q.UnclaimDispatchedTask(ctx, task.ID); resetErr != nil {
				return nil, fmt.Errorf("fixed repo path unavailable and unclaim failed: %w", resetErr)
			}
			return nil, pgx.ErrNoRows
		}
		return nil, fmt.Errorf("acquire fixed repo lock: %w", err)
	}
	return &task, nil
}
```

- [ ] **Step 2: Update `ClaimTask`**

Replace direct `s.Queries.CountRunningTasks` / `s.Queries.ClaimAgentTask` with the same logic using a transaction-scoped `qtx` when `TxStarter` exists. The behavior stays:

```go
if running >= int64(agent.MaxConcurrentTasks) {
	return nil, nil
}
task, err := s.claimTaskWithFixedRepoLock(ctx, qtx, agent)
```

When `claimTaskWithFixedRepoLock` returns `pgx.ErrNoRows` for no available fixed repo path, set outcome to `"no_fixed_repo_path"` and return `nil, nil`.

- [ ] **Step 3: Release locks on terminal paths**

Call `releaseFixedRepoLockForTask`:

- inside the `CompleteTask` transaction after `CompleteAgentTask`.
- inside the `FailTask` transaction after `FailAgentTask`.
- after successful `CancelTask`.
- inside loops for `CancelTasksForIssue`, `CancelTasksForAgent`, `CancelTasksByTriggerComment`, and rerun cancellation.
- at the top of each `HandleFailedTasks` loop so sweeper/recover-orphans release locks.

- [ ] **Step 4: Run lock tests**

Run:

```bash
cd server
set -a; . ../.env.worktree; set +a
go test ./internal/handler -run 'TestFixedRepoClaim' -count=1
```

Expected: PASS.

## Task 4: Claim Response Metadata

**Files:**
- Modify: `server/internal/handler/agent.go`
- Modify: `server/internal/handler/daemon.go`

- [ ] **Step 1: Add response fields**

In `AgentTaskResponse`, add:

```go
FixedRepoMode          bool    `json:"fixed_repo_mode,omitempty"`
FixedRepoPath          string  `json:"fixed_repo_path,omitempty"`
FixedRepoVcsType       string  `json:"fixed_repo_vcs_type,omitempty"`
FixedRepoCleanupScript *string `json:"fixed_repo_cleanup_script,omitempty"`
```

- [ ] **Step 2: Populate claim response**

In `ClaimTaskByRuntime`, after `resp := taskToResponse(*task)`, load active lock:

```go
if lock, err := h.Queries.GetActiveFixedRepoLockForTask(r.Context(), task.ID); err == nil {
	resp.FixedRepoMode = true
	resp.FixedRepoPath = lock.Path
	resp.FixedRepoVcsType = lock.FixedRepoVcsType
	resp.FixedRepoCleanupScript = textToPtr(lock.FixedRepoCleanupScript)
}
```

- [ ] **Step 3: Run metadata test**

Run:

```bash
cd server
set -a; . ../.env.worktree; set +a
go test ./internal/handler -run 'TestClaimTaskByRuntime_FixedRepoMetadata' -count=1
```

Expected: PASS.

## Task 5: Verification And Commit

**Files:**
- All PR2 files above.

- [ ] **Step 1: Run focused tests**

```bash
cd server
set -a; . ../.env.worktree; set +a
go test ./internal/handler -run 'TestFixedRepoClaim|TestClaimTaskByRuntime_FixedRepoMetadata' -count=1
```

Expected: PASS.

- [ ] **Step 2: Run compile checks**

```bash
cd server
set -a; . ../.env.worktree; set +a
go test ./internal/service ./internal/handler -run '^$' -count=1
```

Expected: PASS.

- [ ] **Step 3: Inspect diff**

```bash
git diff --check
git diff --stat
```

Expected: no whitespace errors, only PR2 files plus generated sqlc changes.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-05-24-fixed-repo-claim-locks.md \
  server/migrations/109_agent_fixed_repo_locks.up.sql \
  server/migrations/109_agent_fixed_repo_locks.down.sql \
  server/pkg/db/queries/agent.sql \
  server/pkg/db/generated/models.go \
  server/pkg/db/generated/agent.sql.go \
  server/internal/service/task.go \
  server/internal/handler/agent.go \
  server/internal/handler/daemon.go \
  server/internal/handler/agent_test.go \
  server/internal/handler/daemon_test.go
git commit -m "feat(agents): lock fixed repo paths on claim"
```

Expected: commit succeeds. This branch is ready to push as a stacked PR depending on #3160.

## Self-Review

- Spec coverage: PR2 covers server lock allocation, release, and claim response metadata. Daemon execution remains PR3.
- Placeholder scan: no unfinished placeholders.
- Type consistency: field names match PR1 API names and claim response JSON names.
