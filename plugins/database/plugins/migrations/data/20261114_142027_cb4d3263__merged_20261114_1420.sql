-- singularity:snapshot id=389fe9e6-5218-4950-b39e-267549d4167e parents=edaf80ef-b766-419b-bfdc-a74ea71d0885
-- singularity:supersedes db7bb521
-- singularity:phase expand
ALTER TABLE "supervisor_roles" ADD COLUMN "section" text;
-- singularity:phase contract
ALTER TABLE "supervisor_roles" ADD CONSTRAINT "supervisor_roles_section_conversation_sections_id_fk" FOREIGN KEY ("section") REFERENCES "public"."conversation_sections"("id") ON DELETE set null ON UPDATE no action;
-- singularity:claims
