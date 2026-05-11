-- Remove leftover test-fixture projects from past slice 1 test runs
-- (short_code = 'FX', slug = 'fixture-*'). Tests now clean up after
-- themselves via afterEach hooks (slice 1 followup commit), so no
-- new FX rows accumulate. This wipes the historical crud so it
-- doesn't appear in the Sessions surface filter dropdown or any
-- other place that reads projects.
--
-- Cascades to dependent sessions and llm_calls (project_id FKs are
-- ON DELETE CASCADE).

delete from projects where short_code = 'FX';
