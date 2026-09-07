import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFrontmatterMarkdown } from "./frontmatter.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("parseFrontmatterMarkdown", () => {
  it("reads a plain scalar", () => {
    const doc = parseFrontmatterMarkdown(
      ["---", "name: secret-scan", "description: Scans a diff for secrets.", "---", "", "# Body"].join("\n"),
    );
    expect(doc.frontmatter.name).toBe("secret-scan");
    expect(doc.frontmatter.description).toBe("Scans a diff for secrets.");
    expect(doc.body).toBe("# Body");
  });

  it("folds a `>` block scalar into one line", () => {
    // Every bundled Paperclip skill uses this shape. Before the fix the value
    // parsed as the literal ">" and the text below it was dropped, so the model
    // saw `description: ">"` and could not tell when to use the skill.
    const doc = parseFrontmatterMarkdown(
      [
        "---",
        "name: paperclip",
        "description: >",
        "  Interact with the Paperclip control plane API to manage tasks.",
        "  Use when you need to check assignments or update task status.",
        "---",
        "",
        "# Paperclip Skill",
      ].join("\n"),
    );
    expect(doc.frontmatter.description).toBe(
      "Interact with the Paperclip control plane API to manage tasks. Use when you need to check assignments or update task status.",
    );
    expect(doc.frontmatter.name).toBe("paperclip");
    expect(doc.body).toBe("# Paperclip Skill");
  });

  it("keeps line breaks in a `|` block scalar", () => {
    const doc = parseFrontmatterMarkdown(
      ["---", "notes: |", "  first", "  second", "---", ""].join("\n"),
    );
    expect(doc.frontmatter.notes).toBe("first\nsecond");
  });

  it("accepts chomping indicators", () => {
    const doc = parseFrontmatterMarkdown(
      ["---", "a: >-", "  folded", "b: |-", "  literal", "c: after", "---", ""].join("\n"),
    );
    expect(doc.frontmatter.a).toBe("folded");
    expect(doc.frontmatter.b).toBe("literal");
    expect(doc.frontmatter.c).toBe("after");
  });

  it("does not swallow the key that follows a block scalar", () => {
    const doc = parseFrontmatterMarkdown(
      [
        "---",
        "description: >",
        "  some text",
        "slug: paperclip-dev",
        "required: false",
        "---",
        "",
      ].join("\n"),
    );
    expect(doc.frontmatter.description).toBe("some text");
    expect(doc.frontmatter.slug).toBe("paperclip-dev");
    expect(doc.frontmatter.required).toBe(false);
  });

  it("leaves a nested mapping alone", () => {
    const doc = parseFrontmatterMarkdown(
      [
        "---",
        "name: x",
        "metadata:",
        "  sources:",
        "    -",
        "      kind: github-dir",
        "      repo: paperclipai/paperclip",
        "---",
        "",
      ].join("\n"),
    );
    expect(doc.frontmatter.name).toBe("x");
    expect(doc.frontmatter.metadata).toEqual({
      sources: [{ kind: "github-dir", repo: "paperclipai/paperclip" }],
    });
  });

  it("reads a mapping that starts on the dash line", () => {
    // This is the shape company skill metadata actually uses. This parser used to read
    // the dash line back as the string "kind: github-dir", which is why the two server
    // services kept their own copies instead of importing this one.
    const doc = parseFrontmatterMarkdown(
      [
        "---",
        "name: x",
        "metadata:",
        "  sources:",
        "    - kind: github-dir",
        "      repo: paperclipai/paperclip",
        "      path: skills/paperclip",
        "    - kind: local_path",
        "      path: ./local",
        "---",
        "",
      ].join("\n"),
    );
    expect(doc.frontmatter.metadata).toEqual({
      sources: [
        { kind: "github-dir", repo: "paperclipai/paperclip", path: "skills/paperclip" },
        { kind: "local_path", path: "./local" },
      ],
    });
  });

  it("does not treat a `>` inside prose as a block scalar", () => {
    const doc = parseFrontmatterMarkdown(
      ["---", "description: use a > b when comparing", "---", ""].join("\n"),
    );
    expect(doc.frontmatter.description).toBe("use a > b when comparing");
  });
});

// packages/skills-catalog and packages/teams-catalog ship deliberately dependency-free,
// so they each carry a copy of this file rather than importing it. That copying is what
// let the block-scalar fix land here while both copies — and the two server services that
// had inlined their own — kept parsing `description: >` as the literal ">". Pin the copies
// byte-for-byte so the next fix cannot reach one parser and miss the others.
describe("frontmatter parser copies", () => {
  const canonical = readFileSync(new URL("./frontmatter.ts", import.meta.url), "utf8");

  it.each([
    ["skills-catalog", "packages/skills-catalog/src/frontmatter.ts"],
    ["teams-catalog", "packages/teams-catalog/src/frontmatter.ts"],
  ])("keeps the %s copy identical to packages/shared", (_name, relativePath) => {
    expect(readFileSync(repoRoot + relativePath, "utf8")).toBe(canonical);
  });
});

// The unit tests above prove the parser folds a `>` block. This one proves the shipped
// skills actually reach the parser intact: it reads the real SKILL.md files rather than a
// fixture, which is what the earlier fix lacked — it passed while the live board still
// showed `description: ">"` on every bundled skill.
describe("shipped skill frontmatter", () => {
  const skillsDir = repoRoot + "skills";
  const names = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  it("ships skills to read", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)("gives %s a real description, not the block indicator", (name) => {
    const doc = parseFrontmatterMarkdown(readFileSync(`${skillsDir}/${name}/SKILL.md`, "utf8"));
    const description = doc.frontmatter.description;
    expect(typeof description).toBe("string");
    expect(description).not.toBe(">");
    expect(String(description).length).toBeGreaterThan(40);
  });
});
