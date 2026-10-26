-- Custom SQL migration file, put your code below! --
-- migration: 20261026_140431__rename_improvements_category_to_wishes --
-- The Improve button became Wish: its task category id follows.
UPDATE "tasks_ext_category" SET "category" = 'wishes' WHERE "category" = 'improvements';
