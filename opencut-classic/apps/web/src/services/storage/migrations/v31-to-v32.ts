import { StorageMigration, type StorageMigrationRunArgs } from "./base";
import type { MigrationResult, ProjectRecord } from "./transformers/types";
import { transformProjectV31ToV32 } from "./transformers/v31-to-v32";

/**
 * R1 uniform-tracks migration (see docs/roadmap/50-r1-uniform-tracks-spike.md).
 *
 * Ships alongside the Phase-A spike but is **not yet registered** in
 * `migrations[]` — the shape flip lands in Phase C. Present here so the class
 * shape is fixed and future callers can wire it in without another PR to
 * this directory.
 */
export class V31toV32Migration extends StorageMigration {
	from = 31;
	to = 32;

	async run({
		project,
	}: StorageMigrationRunArgs): Promise<MigrationResult<ProjectRecord>> {
		return transformProjectV31ToV32({ project });
	}
}
