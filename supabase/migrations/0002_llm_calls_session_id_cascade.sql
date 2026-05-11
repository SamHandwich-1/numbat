-- Match llm_calls.project_id's cascade behaviour on session_id.
-- llm_calls are derived from session activity; when a session is
-- deleted, its llm_calls are meaningless on their own. Audit trail
-- lives in the decisions table (project-scoped).

alter table llm_calls
  drop constraint llm_calls_session_id_fkey,
  add constraint llm_calls_session_id_fkey
    foreign key (session_id) references sessions(id)
    on delete cascade;
