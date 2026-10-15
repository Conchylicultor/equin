-- Custom SQL migration file, put your code below! --
-- migration: 20261013_172250__places_roles_been_want --
-- Places status moved from the exclusive Status › Todo / Done roles to two
-- independent role tags: todo → want ("Want to go"), done → been ("Been"). The
-- old `status` parent has no role any more (an ordinary, deletable tag).
UPDATE "place_tags" SET "role" = CASE "role" WHEN 'todo' THEN 'want' WHEN 'done' THEN 'been' END WHERE "role" IN ('status', 'todo', 'done');
UPDATE "place_tags" SET "name" = 'Want to go' WHERE "role" = 'want';
UPDATE "place_tags" SET "name" = 'Been' WHERE "role" = 'been';
UPDATE "place_tags" SET "parent_id" = NULL WHERE "role" IN ('want', 'been');
