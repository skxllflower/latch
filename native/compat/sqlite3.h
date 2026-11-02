// a stand-in for <sqlite3.h>: WAVdesk's library.h (included by its shell files) names the handle types only; this app
// links no SQLite
#pragma once
typedef struct sqlite3 sqlite3;
typedef struct sqlite3_stmt sqlite3_stmt;
