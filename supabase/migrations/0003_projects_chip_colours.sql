-- Chip colour pair per project. Used by ProjectChip in the Sessions
-- surface and (slice 5+) the Plans surface. Pair stored explicitly
-- rather than auto-computing fg from bg — single-operator workflow,
-- trust the operator on contrast.
--
-- Hex strings (e.g. '#3b4a4f'). Format validation lives in Zod at
-- the seed boundary; the column type stays text for simplicity.

alter table projects
  add column chip_bg text,
  add column chip_fg text;

-- Set defaults for the four V1 projects. Existing rows must have
-- values before we backfill the NOT NULL constraint.
update projects set chip_bg = '#3b4a4f', chip_fg = '#cfe6e8' where short_code = 'AO';
update projects set chip_bg = '#4a3a2c', chip_fg = '#e6d3b8' where short_code = 'WT';
update projects set chip_bg = '#3d3a4a', chip_fg = '#cdc6e0' where short_code = 'BB';
update projects set chip_bg = '#2c3e3a', chip_fg = '#bcd0c7' where short_code = 'NB';

-- Fallback for any non-canonical projects (e.g. leftover test-fixture
-- rows with short_code = 'FX'). Placeholder grey is harmless; those
-- rows aren't part of the V1 project set, and the test-cleanup hooks
-- prevent new ones from accumulating. Without this, the NOT NULL
-- constraint below would fail on any dev DB with fixture crud.
update projects set chip_bg = '#333333', chip_fg = '#999999'
  where chip_bg is null;

alter table projects
  alter column chip_bg set not null,
  alter column chip_fg set not null;
