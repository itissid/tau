import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getSessionTitle, SessionSidebar } from "../public/session-sidebar.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.resolve(directory, "../public");

class FakeClassList {
  values = new Set<string>();

  add(...names: string[]) {
    names.forEach((name) => this.values.add(name));
  }

  remove(...names: string[]) {
    names.forEach((name) => this.values.delete(name));
  }

  contains(name: string) {
    return this.values.has(name);
  }

  toggle(name: string, force?: boolean) {
    const enabled = force ?? !this.values.has(name);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }
}

class FakeElement {
  classList = new FakeClassList();
  children: FakeElement[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  listeners = new Map<string, Array<(event: any) => void>>();
  attributes = new Map<string, string>();
  parentElement: FakeElement | null = null;
  scrollOptions: ScrollIntoViewOptions | undefined;
  focused = false;
  tabIndex = -1;
  private html = "";

  set className(value: string) {
    this.classList.values = new Set(value.split(/\s+/).filter(Boolean));
  }

  get className() {
    return [...this.classList.values].join(" ");
  }

  set innerHTML(value: string) {
    this.html = value;
    this.children = [];
  }

  get innerHTML() {
    return this.html;
  }

  appendChild(child: FakeElement) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child: FakeElement, before: FakeElement | null) {
    child.parentElement = this;
    const index = before ? this.children.indexOf(before) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  get firstChild() {
    return this.children[0] || null;
  }

  addEventListener(type: string, listener: (event: any) => void) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, event: Record<string, any> = {}) {
    const dispatched = {
      key: undefined,
      preventDefault() {},
      target: this,
      ...event,
    };
    for (const listener of this.listeners.get(type) || []) listener(dispatched);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  querySelectorAll(selector: string): FakeElement[] {
    assert.match(selector, /^\.[\w-]+$/);
    const className = selector.slice(1);
    const matches: FakeElement[] = [];
    for (const child of this.children) {
      if (child.classList.contains(className)) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] || null;
  }

  scrollIntoView(options?: ScrollIntoViewOptions) {
    this.scrollOptions = options;
  }

  focus() {
    this.focused = true;
  }
}

function installFakeBrowser(projects: unknown[]) {
  const originalDocument = globalThis.document;
  const originalLocalStorage = globalThis.localStorage;
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;

  globalThis.document = {
    addEventListener() {},
    createElement: () => new FakeElement(),
  } as any;
  globalThis.localStorage = {
    getItem: () => null,
    setItem() {},
  } as any;
  globalThis.fetch = async () => ({
    json: async () => ({ projects }),
  }) as any;
  globalThis.location = { pathname: "/" } as any;

  return () => {
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
    globalThis.fetch = originalFetch;
    globalThis.location = originalLocation;
  };
}

test("session titles use the sidebar's name, first-message, and empty-session precedence", () => {
  assert.equal(getSessionTitle({ name: "Named session", firstMessage: "Ignored prompt" }), "Named session");
  assert.equal(getSessionTitle({ name: "", firstMessage: "First useful prompt" }), "First useful prompt");
  assert.equal(getSessionTitle({ name: null, firstMessage: null }), "Empty session");
});

test("revealing the active session expands its project and focuses its keyboard control", async () => {
  const session = {
    filePath: "/sessions/active.jsonl",
    file: "active.jsonl",
    name: "Mobile navigation session",
    firstMessage: "Ignored prompt",
    timestamp: "2026-08-29T00:00:00.000Z",
  };
  const project = {
    dirName: "-workspace-tau",
    path: "/workspace/tau",
    sessions: [session],
  };
  const restore = installFakeBrowser([project]);

  try {
    const container = new FakeElement();
    const selections: unknown[] = [];
    const presentations: unknown[] = [];
    const sidebar = new SessionSidebar(
      container as any,
      (selected: unknown) => selections.push(selected),
      (presentation: unknown) => presentations.push(presentation),
    );

    await sidebar.loadSessions();
    container.querySelector(".project-header")!.dispatch("click");
    assert.equal(container.querySelector(".project-sessions")!.classList.contains("collapsed"), true);

    sidebar.setActive(session.filePath);
    const initiallyActive = container.querySelector(".session-item")!;
    assert.equal(initiallyActive.classList.contains("active"), true);
    assert.equal(initiallyActive.getAttribute("role"), "button");
    assert.equal(initiallyActive.getAttribute("aria-current"), "true");
    assert.equal(initiallyActive.tabIndex, 0);

    initiallyActive.dispatch("keydown", { key: "Enter" });
    assert.equal(selections.length, 1);

    assert.equal(sidebar.revealActiveSession(), true);
    const expandedSessions = container.querySelector(".project-sessions")!;
    const revealedItem = container.querySelector(".session-item")!;
    assert.equal(expandedSessions.classList.contains("collapsed"), false);
    assert.equal(revealedItem.focused, true);
    assert.deepEqual(revealedItem.scrollOptions, { block: "nearest", inline: "nearest" });
    assert.deepEqual(presentations.at(-1), {
      filePath: session.filePath,
      title: "Mobile navigation session",
    });

    sidebar.setActive(session.filePath, { ...session, name: "Reconnect title" });
    assert.deepEqual(presentations.at(-1), {
      filePath: session.filePath,
      title: "Reconnect title",
    });
  } finally {
    restore();
  }
});

test("the mobile header exposes the current session as accessible sidebar navigation", () => {
  const html = readFileSync(path.join(publicDirectory, "index.html"), "utf8");
  const app = readFileSync(path.join(publicDirectory, "app.js"), "utf8");
  const css = readFileSync(path.join(publicDirectory, "style.css"), "utf8");

  assert.match(
    html,
    /<button[^>]*id="current-session-title"[^>]*type="button"[^>]*aria-controls="sidebar"[^>]*>/,
  );
  assert.match(css, /\.current-session-title\s*\{[^}]*display:\s*none;/s);
  assert.match(
    css,
    /@media \(max-width: 768px\)[\s\S]*?\.current-session-title\s*\{[^}]*display:\s*flex;/,
  );
  assert.match(app, /sidebar\.setActive\(data\.sessionFile,\s*\{[\s\S]*?name:\s*data\.sessionName/);
  assert.match(app, /currentSessionTitle\.addEventListener\('click',[\s\S]*?sidebar\.revealActiveSession\(\)/);
  assert.match(app, /case 'session_name':[\s\S]*?mirrorActiveSessionFile[\s\S]*?sidebar\.updateSessionName\(liveSessionFile, event\.name\)/);
});
