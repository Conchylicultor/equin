-- singularity:snapshot id=457c6664-ccba-439b-abb4-6a4a0a5deffd parents=47a1b1b9-4d5a-4dba-ac95-efa8a1d67c54
-- singularity:supersedes 9f94b553
-- singularity:phase expand
ALTER TABLE "events_test_pinged_triggers" ADD COLUMN "declared" boolean DEFAULT false NOT NULL;
ALTER TABLE "sonata_ug_tabSaved_triggers" ADD COLUMN "declared" boolean DEFAULT false NOT NULL;
ALTER TABLE "conversation_flagRaised_triggers" ADD COLUMN "declared" boolean DEFAULT false NOT NULL;
ALTER TABLE "conversation_userTurnSent_triggers" ADD COLUMN "declared" boolean DEFAULT false NOT NULL;
ALTER TABLE "conversation_turn-completed_triggers" ADD COLUMN "declared" boolean DEFAULT false NOT NULL;
ALTER TABLE "git_refAdvanced_triggers" ADD COLUMN "declared" boolean DEFAULT false NOT NULL;
ALTER TABLE "supervisedRun_ended_triggers" ADD COLUMN "declared" boolean DEFAULT false NOT NULL;
ALTER TABLE "page_blocksChanged_triggers" ADD COLUMN "declared" boolean DEFAULT false NOT NULL;
ALTER TABLE "tasks_autoStartArmed_triggers" ADD COLUMN "declared" boolean DEFAULT false NOT NULL;
ALTER TABLE "outcomeReport_submitted_triggers" ADD COLUMN "declared" boolean DEFAULT false NOT NULL;
ALTER TABLE "tasks_trackChanged_triggers" ADD COLUMN "declared" boolean DEFAULT false NOT NULL;
ALTER TABLE "conversation_created_triggers" ADD COLUMN "declared" boolean DEFAULT false NOT NULL;
ALTER TABLE "conversation_statusChanged_triggers" ADD COLUMN "declared" boolean DEFAULT false NOT NULL;
ALTER TABLE "pushes_landed_triggers" ADD COLUMN "declared" boolean DEFAULT false NOT NULL;
ALTER TABLE "tasks_created_triggers" ADD COLUMN "declared" boolean DEFAULT false NOT NULL;
ALTER TABLE "tasks_descriptionChanged_triggers" ADD COLUMN "declared" boolean DEFAULT false NOT NULL;
ALTER TABLE "tasks_mandateChanged_triggers" ADD COLUMN "declared" boolean DEFAULT false NOT NULL;
ALTER TABLE "tasks_refiled_triggers" ADD COLUMN "declared" boolean DEFAULT false NOT NULL;
ALTER TABLE "tasks_statusChanged_triggers" ADD COLUMN "declared" boolean DEFAULT false NOT NULL;
ALTER TABLE "tasks_titleChanged_triggers" ADD COLUMN "declared" boolean DEFAULT false NOT NULL;
-- singularity:phase contract
-- singularity:claims
