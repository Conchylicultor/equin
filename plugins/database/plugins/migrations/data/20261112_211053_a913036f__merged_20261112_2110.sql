-- singularity:snapshot id=5dd8b139-d7b3-46b5-a5c1-6f619e9e4df7 parents=53e1d179-c084-4023-b5c5-1036f6b0e077
-- singularity:supersedes 759e8920
-- singularity:supersedes 759e8920 <- 26785727
-- singularity:phase expand
ALTER TABLE "reports" ADD COLUMN "skew_proven" boolean DEFAULT false NOT NULL;
-- singularity:phase contract
-- singularity:claims
