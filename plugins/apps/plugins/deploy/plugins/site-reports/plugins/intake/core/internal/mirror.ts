/**
 * The id of the `site_reports` mirror set: the change stream the deploy
 * app's site-reports/import reads from a deployed site's box (never copied as
 * rows — its reduce step is the replica's sink).
 */
export const SITE_REPORTS_MIRROR_SET_ID = "site_reports";
