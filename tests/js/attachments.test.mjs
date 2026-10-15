import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createAttachments, isAllowedType } from "../../static/js/attachments.js";

const MB = 1024 * 1024;
const file = (name, type, size, modified = 1) => new File([new Uint8Array(size)], name, { type, lastModified: modified });

function setup(opts = {}) {
  const { window } = new JSDOM('<div id="tray" hidden><ul id="list"></ul></div>');
  const doc = window.document;
  const revoked = [], errors = [], changes = [];
  let n = 0;
  const att = createAttachments({
    trayEl: doc.getElementById("tray"), listEl: doc.getElementById("list"),
    maxImages: 3, maxBytes: 5 * MB,
    urlApi: { createObjectURL: () => `blob:${++n}`, revokeObjectURL: (u) => revoked.push(u) },
    onError: (m) => errors.push(m), onChange: (f) => changes.push(f.length), ...opts,
  });
  return { att, doc, revoked, errors, changes };
}

test("accepts JPEG, PNG and WebP; rejects other types", () => {
  assert.ok(isAllowedType(file("a.jpg", "image/jpeg", 1)));
  assert.ok(isAllowedType(file("a.webp", "image/webp", 1)));
  assert.ok(!isAllowedType(file("a.gif", "image/gif", 1)));
  assert.ok(!isAllowedType(file("a.pdf", "application/pdf", 1)));
  assert.ok(isAllowedType(file("a.PNG", "", 1)), "falls back to the extension when type is empty");
});

test("adds valid images, shows the tray and previews", () => {
  const { att, doc } = setup();
  att.add([file("a.png", "image/png", 1000)]);
  assert.equal(att.count, 1);
  assert.equal(doc.getElementById("tray").hidden, false);
  assert.equal(doc.querySelector(".thumb img").getAttribute("src"), "blob:1");
  assert.match(doc.querySelector(".thumb-remove").getAttribute("aria-label"), /Remove a\.png/);
});

test("rejects bad type, empty and oversized files with clear messages", () => {
  const { att, errors } = setup();
  att.add([file("a.gif", "image/gif", 10), file("e.png", "image/png", 0), file("big.png", "image/png", 6 * MB)]);
  assert.equal(att.count, 0);
  assert.match(errors[0], /a\.gif isn't a supported image/);
  assert.match(errors[1], /e\.png is empty/);
  assert.match(errors[2], /big\.png is 6\.0 MB\. The limit is 5 MB/);
});

test("enforces the image count once and ignores duplicates", () => {
  const { att, errors } = setup();
  att.add([file("1.png", "image/png", 10, 1), file("2.png", "image/png", 10, 2), file("3.png", "image/png", 10, 3)]);
  att.add([file("4.png", "image/png", 10, 4), file("5.png", "image/png", 10, 5)]);
  assert.equal(att.count, 3);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /up to 3 images/);
  att.add([file("1.png", "image/png", 10, 1)]);
  assert.equal(att.count, 3);
});

test("remove and clear revoke object URLs and hide the tray", () => {
  const { att, doc, revoked, changes } = setup();
  att.add([file("a.png", "image/png", 10, 1), file("b.png", "image/png", 10, 2)]);
  doc.querySelector(".thumb-remove").click();
  assert.equal(att.count, 1);
  assert.deepEqual(revoked, ["blob:1"]);
  att.clear();
  assert.equal(att.count, 0);
  assert.equal(doc.getElementById("tray").hidden, true);
  assert.deepEqual(revoked, ["blob:1", "blob:2"]);
  assert.equal(changes.at(-1), 0);
});

test("an image the browser cannot decode is removed with a message", () => {
  const { att, doc, errors } = setup();
  att.add([file("broken.png", "image/png", 10)]);
  doc.querySelector(".thumb img").dispatchEvent(new doc.defaultView.Event("error"));
  assert.equal(att.count, 0);
  assert.match(errors[0], /broken\.png can't be read as an image/);
});
