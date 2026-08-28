import assert from "node:assert/strict";
import test from "node:test";

import { DialogHandler } from "../public/dialogs.js";

class FakeClassList {
  values = new Set<string>();
  add(value: string) { this.values.add(value); }
  remove(value: string) { this.values.delete(value); }
  contains(value: string) { return this.values.has(value); }
}

class FakeElement {
  className = "";
  classList = new FakeClassList();
  children: FakeElement[] = [];
  nodes = new Map<string, FakeElement>();
  onclick: undefined | (() => void);
  textContent = "";
  value = "";
  private markup = "";

  set innerHTML(value: string) {
    this.markup = value;
    if (value === "") {
      this.children = [];
      this.nodes.clear();
    }
  }
  get innerHTML() { return this.markup; }

  appendChild(child: FakeElement) { this.children.push(child); return child; }
  querySelector(selector: string) {
    let node = this.nodes.get(selector);
    if (!node) {
      node = new FakeElement();
      this.nodes.set(selector, node);
    }
    return node;
  }
  addEventListener() {}
  focus() {}
  remove() {}
}

test("Tau confirmation dialogs preserve request identity and can be dismissed by the winning projection", () => {
  const originalDocument = globalThis.document;
  const container = new FakeElement();
  container.classList.add("hidden");
  const sent: unknown[] = [];
  globalThis.document = {
    createElement: () => new FakeElement(),
    getElementById: () => null,
  } as any;

  try {
    const dialogs = new DialogHandler(container as any, { send: (message: unknown) => sent.push(message) });
    dialogs.showConfirm({
      id: "safety-gate-browser-approve",
      title: "Safety approval",
      message: "bash is paused",
    });
    assert.equal(container.classList.contains("hidden"), false);
    const dialog = container.children[0]!;
    dialog.querySelector("#dialog-yes")!.onclick!();
    assert.deepEqual(sent, [{
      type: "extension_ui_response",
      id: "safety-gate-browser-approve",
      confirmed: true,
    }]);
    assert.equal(container.classList.contains("hidden"), true);

    dialogs.showConfirm({
      id: "safety-gate-browser-deny",
      title: "Safety approval",
      message: "bash is paused",
    });
    container.children[0]!.querySelector("#dialog-no")!.onclick!();
    assert.deepEqual(sent.at(-1), {
      type: "extension_ui_response",
      id: "safety-gate-browser-deny",
      confirmed: false,
    });

    dialogs.showConfirm({
      id: "safety-gate-terminal-wins",
      title: "Safety approval",
      message: "write is paused",
    });
    assert.equal(dialogs.dismiss("different-request"), false);
    assert.equal(container.classList.contains("hidden"), false);
    assert.equal(dialogs.dismiss("safety-gate-terminal-wins"), true);
    assert.equal(container.classList.contains("hidden"), true);
  } finally {
    globalThis.document = originalDocument;
  }
});
