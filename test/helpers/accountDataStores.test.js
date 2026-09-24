const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  const callbacks = {};
  const ipc = {
    authGetStatus: async () => ({ status: "authenticated", user: { id: "A" } }),
  };
  for (const name of [
    "AuthStateChanged",
    "TranscriptionAdded",
    "TranscriptionUpdated",
    "TranscriptionDeleted",
    "TranscriptionsCleared",
    "NoteAdded",
    "NoteUpdated",
    "NoteDeleted",
  ]) {
    ipc[`on${name}`] = (cb) => {
      (callbacks[name] ||= []).push(cb);
      return () => {};
    };
  }
  const modules = new Map();
  const create = () => (init) => {
    let state = init();
    const store = (selector) => selector(state);
    store.getState = () => state;
    store.setState = (next) => {
      state = { ...state, ...(typeof next === "function" ? next(state) : next) };
    };
    return store;
  };
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const file = path.join(__dirname, "../../src/stores", `${name}.ts`);
    const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const exports = {};
    modules.set(name, exports);
    vm.runInNewContext(source, {
      exports,
      require: (request) => (request === "zustand" ? { create } : load(request.replace("./", ""))),
      window: { electronAPI: ipc, addEventListener() {} },
      console,
    });
    return exports;
  }
  return {
    ipc,
    load,
    emit: (name, payload) => {
      for (const cb of callbacks[name] || []) cb(payload);
    },
  };
}

for (const [name, initialize, read, event] of [
  ["transcriptionStore", "initializeTranscriptions", "useTranscriptions", "TranscriptionAdded"],
  ["noteStore", "initializeNotes", "useNotes", "NoteAdded"],
  ["chatStore", "initializeConversations", "useConversations", null],
]) {
  test(`${name} clears private cache on logout and rejects late account A results/events`, async () => {
    const { ipc, load, emit } = fixture();
    const pending = deferred();
    const getter =
      name === "noteStore"
        ? "getNotes"
        : name === "chatStore"
          ? "getAgentConversations"
          : "getTranscriptions";
    ipc[getter] = async () => [{ id: 1, privacy_scope_id: "account:A" }];
    const store = load(name);
    await store[initialize]();
    assert.equal(store[read]().length, 1);
    ipc[getter] = () => pending.promise;
    const inFlight = store[initialize]();
    await Promise.resolve();
    emit("AuthStateChanged", { status: "signed-out", user: null });
    assert.equal(store[read]().length, 0);
    emit("AuthStateChanged", { status: "authenticated", user: { id: "B" } });
    pending.resolve([{ id: 1, privacy_scope_id: "account:A" }]);
    assert.equal((await inFlight).length, 0);
    const deliver = (item) => (event ? emit(event, item) : store.addConversation(item));
    deliver({ id: 1, privacy_scope_id: "account:A" });
    assert.equal(store[read]().length, 0);
    deliver({ id: 2, privacy_scope_id: "account:B" });
    assert.equal(store[read]()[0].id, 2);
    emit("AuthStateChanged", { status: "authenticated", user: { id: "B" } });
    assert.equal(store[read]()[0].id, 2, "token refresh preserves the same-account cache");
  });
}
