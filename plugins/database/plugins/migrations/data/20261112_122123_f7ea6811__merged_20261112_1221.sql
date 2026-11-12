-- singularity:snapshot id=ae2f279d-5a12-468e-9866-ed0507e3e212 parents=d60f08a0-e56e-4e26-973c-61e1e0ead0b3
-- singularity:supersedes e3269063
-- singularity:supersedes e3269063 <- 0b875117
-- singularity:supersedes 0b875117 <- 97d39b78
-- singularity:supersedes 97d39b78 <- dcb8abfa
-- singularity:supersedes dcb8abfa <- a806784f
-- singularity:supersedes a806784f <- 0308fe1c
-- singularity:supersedes 0308fe1c <- 4bcbca09
-- singularity:supersedes 4bcbca09 <- 5478db5d
-- singularity:supersedes 5478db5d <- 652f905e
-- singularity:phase expand
CREATE TABLE "deploy_host_stand_ins" (
	"server_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- singularity:phase contract
ALTER TABLE "deploy_host_stand_ins" ADD CONSTRAINT "deploy_host_stand_ins_server_id_deploy_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."deploy_servers"("id") ON DELETE cascade ON UPDATE cascade;
-- singularity:claims
