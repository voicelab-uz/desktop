const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/debouncedNoteSaver.ts");

test("navigation flushes the latest title, body and enhanced draft exactly once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { createDebouncedNoteSaver } = await load();
  const writes = [];
  const saver = createDebouncedNoteSaver(
    async (id, patch) => writes.push({ id, patch }),
    assert.fail
  );
  saver.schedule(7, { title: "New title", content: "first" });
  saver.schedule(7, { content: "last keystroke" });
  saver.schedule(7, { enhanced_content: "edited enhancement" });
  assert.equal(writes.length, 0);
  await saver.flush();
  t.mock.timers.tick(2000);
  assert.deepEqual(writes, [
    {
      id: 7,
      patch: {
        title: "New title",
        content: "last keystroke",
        enhanced_content: "edited enhancement",
      },
    },
  ]);
});

test("switching notes flushes the old draft without applying it to the new note", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { createDebouncedNoteSaver } = await load();
  const writes = [];
  const saver = createDebouncedNoteSaver(
    async (id, patch) => writes.push({ id, patch }),
    assert.fail
  );
  saver.schedule(1, { enhanced_content: "old enhancement" });
  saver.schedule(2, { content: "new body" });
  assert.equal(saver.hasPending(1), false);
  assert.equal(saver.hasPending(2), true);
  t.mock.timers.tick(1000);
  assert.deepEqual(writes, [
    { id: 1, patch: { enhanced_content: "old enhancement" } },
    { id: 2, patch: { content: "new body" } },
  ]);
});

test("deleting another note cannot discard the active draft", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { createDebouncedNoteSaver } = await load();
  const writes = [];
  const saver = createDebouncedNoteSaver(async (id) => writes.push(id), assert.fail);
  saver.schedule(1, { content: "keep" });
  saver.cancel(2);
  await saver.flush();
  saver.schedule(2, { content: "deleted" });
  saver.cancel(2);
  await saver.flush();
  t.mock.timers.tick(2000);
  assert.deepEqual(writes, [1]);
});

test("a failed flush is handled without an unhandled rejection", async () => {
  const { createDebouncedNoteSaver } = await load();
  const errors = [];
  const saver = createDebouncedNoteSaver(
    async () => {
      throw new Error("disk unavailable");
    },
    (e) => errors.push(e.message)
  );
  saver.schedule(1, { content: "draft" });
  await saver.flush();
  assert.deepEqual(errors, ["disk unavailable"]);
});
