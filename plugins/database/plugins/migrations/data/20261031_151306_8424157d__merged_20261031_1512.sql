-- singularity:snapshot id=b02e4416-c2bf-4b1c-94cd-0cfc598ff989 parents=83662d2d-ddf5-4f51-a8b4-c91bc7a69db3
-- singularity:supersedes f330d490
-- singularity:phase expand
ALTER TABLE "conversations_ext_sdk_agent" ADD COLUMN "events_position" jsonb;
-- singularity:phase contract
-- singularity:claims
