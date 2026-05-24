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
