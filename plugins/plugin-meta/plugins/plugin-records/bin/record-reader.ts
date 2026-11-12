// One reader thread of the shared record store (`cli/`'s `openRecordStore`):
// answers each batch of lookups from its own connection, so the random page
// reads of a multi-GB file never hold the asking process's thread — a check
// pass's one thread is every check's.

import { serveRecordReads } from "../cli";

serveRecordReads();
