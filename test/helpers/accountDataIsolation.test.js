const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { randomBytes } = require("node:crypto");
const Database = require("better-sqlite3");
const load = Module._load;
Module._load = function (name, parent, isMain) {
  if (name === "electron") return { app: {}, safeStorage: {} };
  return load.call(this, name, parent, isMain);
};
const DatabaseManager = require("../../src/helpers/database");
const { LocalDataCrypto } = require("../../src/helpers/localDataCrypto");
Module._load = load;

function fixture(t) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE transcriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, client_transcription_id TEXT,
      privacy_scope_id TEXT DEFAULT 'device-local', text TEXT, raw_text TEXT,
      error_message TEXT, error_code TEXT, status TEXT DEFAULT 'completed',
      deleted_at TEXT, timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, cloud_id TEXT, sync_status TEXT,
      desktop_transcription_id TEXT, desktop_revision INTEGER,
      desktop_audio_available INTEGER, audio_duration_ms INTEGER, provider TEXT,
      model TEXT, has_audio INTEGER DEFAULT 0, route_kind TEXT
    );
    CREATE UNIQUE INDEX desktop_identity ON transcriptions(privacy_scope_id, desktop_transcription_id);
    CREATE TABLE agent_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, client_conversation_id TEXT,
      privacy_scope_id TEXT, title TEXT, note_id INTEGER, cloud_id TEXT,
      deleted_at TEXT, archived_at TEXT, sync_status TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER,
      client_message_id TEXT, privacy_scope_id TEXT, role TEXT,
      content TEXT, metadata TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE folders (id INTEGER PRIMARY KEY, name TEXT, is_default INTEGER, cloud_id TEXT);
    INSERT INTO folders VALUES (1, 'Personal', 1, NULL), (2, 'Shared', 0, NULL);
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY, client_note_id TEXT, privacy_scope_id TEXT,
      title TEXT, content TEXT, enhanced_content TEXT, enhancement_prompt TEXT,
      note_type TEXT, source_file TEXT, audio_duration_seconds INTEGER,
      folder_id INTEGER, deleted_at TEXT, cloud_id TEXT, sync_status TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const crypto = new LocalDataCrypto({
    userDataPath: "/tmp",
    wrappingCrypto: {},
    persist: false,
    registry: {
      format: 1,
      current: 1,
      keys: { 1: randomBytes(32).toString("base64") },
      index_key: randomBytes(32).toString("base64"),
    },
  });
  const manager = Object.create(DatabaseManager.prototype);
  manager.db = db;
  manager.localDataProtection = {
    protect: (table, row, field, value) => crypto.encryptText(value, { table, row, field }),
    reveal: (table, row, field, value) => crypto.decryptText(value, { table, row, field }),
  };
  let account = null;
  manager.setAccountProvider(() => account);
  return {
    manager,
    db,
    account: (id) => {
      account = id;
    },
  };
}
const remote = (id, createdAt = "2026-01-01T00:00:00Z") => ({
  id,
  transcript: `private ${id}`,
  revision: 1,
  createdAt,
});

test("desktop authentication isolates local history independently of sync activation", (t) => {
  const { manager, db, account } = fixture(t);
  manager.desktopSyncStore = { activeAccount: () => ({ account_id: "unrelated-sync-account" }) };
  account("A");
  const a = manager.saveTranscription("A's local dictation").transcription;
  assert.equal(a.privacy_scope_id, "account:A");
  manager.desktopSyncStore.activeAccount = () => null;
  assert.equal(manager.getTranscriptions()[0].text, "A's local dictation");
  account(null);
  assert.deepEqual(manager.getTranscriptions(), []);
  account("B");
  assert.deepEqual(manager.getTranscriptions(), []);
  assert.equal(manager.getTranscriptionById(a.id), null);
  assert.equal(manager.updateTranscriptionText(a.id, "overwrite", null).success, false);
  assert.equal(manager.updateTranscriptionStatus(a.id, "failed").success, false);
  assert.equal(manager.updateTranscriptionAudio(a.id, { hasAudio: 0 }).success, false);
  assert.equal(manager.deleteTranscription(a.id).success, false);
  manager.saveTranscription("B's local dictation");
  manager.clearTranscriptions();
  account("A");
  assert.equal(manager.getTranscriptions()[0].text, "A's local dictation");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM transcriptions").get().count, 1);
});

test("unknown legacy records stay untouched while server ownership permits a separate account copy", (t) => {
  const { manager, db, account } = fixture(t);
  manager.accountProvider = undefined;
  const legacy = manager.upsertDesktopTranscription(remote("old-record"));
  assert.equal(legacy.privacy_scope_id, "device-local");
  let active = "A";
  manager.setAccountProvider(() => active);
  assert.deepEqual(manager.getTranscriptions(), []);
  const owned = manager.upsertDesktopTranscription(remote("old-record"));
  assert.notEqual(owned.id, legacy.id);
  assert.equal(owned.privacy_scope_id, "account:A");
  active = "B";
  assert.deepEqual(manager.getTranscriptions(), []);
  account(null);
  manager.clearTranscriptions();
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM transcriptions WHERE privacy_scope_id = 'device-local'"
      )
      .get().count,
    1
  );
});

test("single removal remains hidden on reimport and relogin but cannot hide another account's records", (t) => {
  const { manager, account } = fixture(t);
  account("A");
  const item = manager.upsertDesktopTranscription(remote("record"));
  assert.equal(manager.deleteTranscription(item.id).success, true);
  assert.equal(manager.upsertDesktopTranscription(remote("record")), null);
  account("B");
  assert.ok(manager.upsertDesktopTranscription(remote("record")));
  account("A");
  const reopened = Object.assign(Object.create(DatabaseManager.prototype), manager);
  assert.equal(reopened.upsertDesktopTranscription(remote("record")), null);
  assert.deepEqual(reopened.getTranscriptions(), []);
});

test("clear hides unseen older server pages as well as loaded records and accepts future dictations", (t) => {
  const { manager, account } = fixture(t);
  account("A");
  manager.upsertDesktopTranscription(remote("loaded"));
  assert.equal(manager.clearTranscriptions().cleared, 1);
  assert.equal(manager.upsertDesktopTranscription(remote("loaded")), null);
  assert.equal(manager.upsertDesktopTranscription(remote("unseen-page-2")), null);
  assert.ok(
    manager.upsertDesktopTranscription(remote("new", new Date(Date.now() + 60_000).toISOString()))
  );
  account("B");
  assert.ok(manager.upsertDesktopTranscription(remote("unseen-page-2")));
});

test("notes cannot be read, edited, searched, counted or deleted through another account", (t) => {
  const { manager, account } = fixture(t);
  account("A");
  const a = manager.saveNote("private title", "secret contents", "personal", null, null, 2).note;
  account("B");
  assert.deepEqual(manager.getNotes(), []);
  assert.equal(manager.getNote(a.id), null);
  assert.deepEqual(manager.searchNotes("secret"), []);
  assert.deepEqual(manager.getFolderNoteCounts(), []);
  assert.equal(manager.updateNote(a.id, { content: "overwrite" }).success, false);
  assert.equal(manager.deleteNote(a.id).success, false);
  assert.equal(manager.deleteFolder(2).success, false);
  account("A");
  assert.equal(manager.getNote(a.id).content, "secret contents");
});

test("conversation lists, messages, previews, search and mutations are account isolated", (t) => {
  const { manager, account } = fixture(t);
  account("A");
  const note = manager.saveNote("private note", "contents").note;
  const conversation = manager.createAgentConversation("private conversation", note.id);
  manager.addAgentMessage(conversation.id, "user", "private message", { source: "note" });
  assert.equal(manager.getConversationsForNote(note.id)[0].title, "private conversation");
  assert.equal(manager.getAgentMessages(conversation.id)[0].content, "private message");
  assert.equal(manager.getAgentConversationsWithPreview()[0].last_message, "private message");
  account("B");
  assert.deepEqual(manager.getAgentConversations(), []);
  assert.equal(manager.getAgentConversation(conversation.id), null);
  assert.deepEqual(manager.getConversationsForNote(note.id), []);
  assert.deepEqual(manager.getAgentMessages(conversation.id), []);
  assert.deepEqual(manager.getAgentConversationsWithPreview(), []);
  assert.deepEqual(manager.searchAgentConversations("private"), []);
  assert.equal(manager.updateAgentConversationTitle(conversation.id, "overwrite").success, false);
  assert.equal(manager.archiveAgentConversation(conversation.id).success, false);
  assert.equal(manager.unarchiveAgentConversation(conversation.id).success, false);
  assert.equal(manager.updateAgentConversationCloudId(conversation.id, "wrong").success, false);
  assert.equal(manager.deleteAgentConversation(conversation.id).success, false);
  assert.throws(() => manager.addAgentMessage(conversation.id, "assistant", "wrong"), /not found/);
  assert.throws(() => manager.createAgentConversation("wrong", note.id), /not found/);
  account("A");
  assert.equal(manager.getAgentConversation(conversation.id).title, "private conversation");
  assert.equal(manager.getAgentMessages(conversation.id).length, 1);
});
