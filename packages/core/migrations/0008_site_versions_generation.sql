-- Owner deletion (ruling I-4): the foreign-key check of site_versions.generation_id.

-- site_versions.generation_id references generations, and until now had no index. When a generation is deleted (deleteOwner
-- deletes every generation of an owner's sites), SQLite checks the child table with "SELECT rowid FROM site_versions WHERE
-- generation_id = ?" (https://www.sqlite.org/foreignkeys.html: "If these queries cannot use an index, they are forced to do a
-- linear scan of the entire child table"), so each deleted generation read every stored version. Measured in D1 on 2026-10-06
-- (.superpowers/evidence/owner-deletion/part1/review): 20,020 rows read against 20 for 10 generations over 2,000 versions.
-- D1 bills every row a query reads. With this index the check is a lookup. The plans of both of deleteOwner's generations
-- deletes are pinned in packages/core/test/migration.workerd.test.ts, and docs/runbooks/go-live.md G5.2c asks production for them.
-- D1 advises PRAGMA optimize after creating an index; at go-live the table is empty (a new database), so there is nothing to build.
CREATE INDEX site_versions_generation ON site_versions(generation_id);
