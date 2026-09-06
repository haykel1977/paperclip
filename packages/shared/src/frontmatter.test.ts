import { describe, expect, it } from "vitest";
import { parseFrontmatterMarkdown } from "./frontmatter.js";

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

  it("does not treat a `>` inside prose as a block scalar", () => {
    const doc = parseFrontmatterMarkdown(
      ["---", "description: use a > b when comparing", "---", ""].join("\n"),
    );
    expect(doc.frontmatter.description).toBe("use a > b when comparing");
  });
});
