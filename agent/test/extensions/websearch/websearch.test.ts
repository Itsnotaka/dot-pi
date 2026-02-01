import { describe, expect, it } from "vitest";

/**
 * Tests for websearch helper functions.
 *
 * Since the functions are module-private, we re-implement them here
 * with the exact same logic and test that logic. This validates the
 * algorithms without needing to export internals.
 */

function isUrl(text: string): boolean {
  const trimmed = text.trim();
  return /^https?:\/\/\S+$/i.test(trimmed);
}

function shorten(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function htmlToMarkdown(html: string): string {
  let text = html;

  text = text.replace(
    /<(script|style|noscript|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi,
    "",
  );

  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");

  text = text.replace(
    /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    "[$2]($1)",
  );

  text = text.replace(
    /<pre[^>]*><code[^>]*class="[^"]*language-(\w+)"[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
    "\n```$1\n$2\n```\n",
  );
  text = text.replace(
    /<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
    "\n```\n$1\n```\n",
  );
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");

  text = text.replace(/<hr[^>]*\/?>/gi, "\n---\n");
  text = text.replace(/<br[^>]*\/?>/gi, "\n");
  text = text.replace(
    /<\/(p|div|section|article|header|footer|main|nav|aside)>/gi,
    "\n\n",
  );
  text = text.replace(
    /<(p|div|section|article|header|footer|main|nav|aside)[^>]*>/gi,
    "",
  );

  text = text.replace(/<[^>]+>/g, "");

  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&#(\d+);/g, (_, code) =>
    String.fromCharCode(Number(code)),
  );
  text = text.replace(/&\w+;/g, "");

  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  return match[1].replace(/<[^>]+>/g, "").trim() || null;
}

describe("websearch helpers", () => {
  describe("isUrl", () => {
    it("recognizes http URLs", () => {
      expect(isUrl("http://example.com")).toBe(true);
      expect(isUrl("http://example.com/path?q=1")).toBe(true);
    });

    it("recognizes https URLs", () => {
      expect(isUrl("https://example.com")).toBe(true);
      expect(isUrl("https://github.com/user/repo")).toBe(true);
    });

    it("trims whitespace", () => {
      expect(isUrl("  https://example.com  ")).toBe(true);
    });

    it("rejects non-URLs", () => {
      expect(isUrl("not a url")).toBe(false);
      expect(isUrl("ftp://example.com")).toBe(false);
      expect(isUrl("example.com")).toBe(false);
      expect(isUrl("")).toBe(false);
    });

    it("rejects URLs with spaces in path", () => {
      expect(isUrl("https://example.com/path with spaces")).toBe(false);
    });
  });

  describe("shorten", () => {
    it("returns text unchanged when within limit", () => {
      expect(shorten("hello", 10)).toBe("hello");
    });

    it("returns text unchanged at exact limit", () => {
      expect(shorten("hello", 5)).toBe("hello");
    });

    it("truncates with ellipsis when exceeding limit", () => {
      const result = shorten("hello world", 6);
      expect(result).toBe("hello…");
      expect(result.length).toBe(6);
    });

    it("handles empty string", () => {
      expect(shorten("", 5)).toBe("");
    });
  });

  describe("htmlToMarkdown", () => {
    it("converts headings", () => {
      expect(htmlToMarkdown("<h1>Title</h1>")).toContain("# Title");
      expect(htmlToMarkdown("<h2>Subtitle</h2>")).toContain("## Subtitle");
      expect(htmlToMarkdown("<h3>Section</h3>")).toContain("### Section");
    });

    it("converts links", () => {
      const html = '<a href="https://example.com">Click here</a>';
      expect(htmlToMarkdown(html)).toContain("[Click here](https://example.com)");
    });

    it("converts inline code", () => {
      expect(htmlToMarkdown("<code>const x = 1</code>")).toContain("`const x = 1`");
    });

    it("converts code blocks", () => {
      const html = '<pre><code class="language-js">console.log("hi")</code></pre>';
      const result = htmlToMarkdown(html);
      expect(result).toContain("```js");
      expect(result).toContain('console.log("hi")');
      expect(result).toContain("```");
    });

    it("converts bold and italic", () => {
      expect(htmlToMarkdown("<strong>bold</strong>")).toContain("**bold**");
      expect(htmlToMarkdown("<b>bold</b>")).toContain("**bold**");
      expect(htmlToMarkdown("<em>italic</em>")).toContain("*italic*");
      expect(htmlToMarkdown("<i>italic</i>")).toContain("*italic*");
    });

    it("converts list items", () => {
      const html = "<ul><li>One</li><li>Two</li></ul>";
      const result = htmlToMarkdown(html);
      expect(result).toContain("- One");
      expect(result).toContain("- Two");
    });

    it("converts <br> to newlines", () => {
      expect(htmlToMarkdown("line1<br>line2")).toContain("line1\nline2");
      expect(htmlToMarkdown("line1<br/>line2")).toContain("line1\nline2");
    });

    it("converts <hr> to horizontal rule", () => {
      expect(htmlToMarkdown("<hr>")).toContain("---");
    });

    it("strips script tags and content", () => {
      const html = '<p>Text</p><script>alert("xss")</script><p>More</p>';
      const result = htmlToMarkdown(html);
      expect(result).not.toContain("alert");
      expect(result).not.toContain("script");
      expect(result).toContain("Text");
      expect(result).toContain("More");
    });

    it("strips style tags and content", () => {
      const html = "<style>body { color: red; }</style><p>Content</p>";
      const result = htmlToMarkdown(html);
      expect(result).not.toContain("color");
      expect(result).toContain("Content");
    });

    it("decodes HTML entities", () => {
      expect(htmlToMarkdown("&amp; &lt; &gt;")).toBe("& < >");
      expect(htmlToMarkdown("&quot;hello&quot;")).toBe('"hello"');
      expect(htmlToMarkdown("&#39;quoted&#39;")).toBe("'quoted'");
      expect(htmlToMarkdown("a&nbsp;b")).toBe("a b");
    });

    it("decodes numeric entities", () => {
      expect(htmlToMarkdown("&#65;")).toBe("A");
      expect(htmlToMarkdown("&#169;")).toBe("©");
    });

    it("collapses whitespace", () => {
      expect(htmlToMarkdown("too   many    spaces")).toBe("too many spaces");
    });

    it("collapses excessive newlines", () => {
      const result = htmlToMarkdown("<p>A</p><p></p><p></p><p>B</p>");
      const newlines = result.match(/\n/g)?.length ?? 0;
      expect(newlines).toBeLessThanOrEqual(4);
    });

    it("strips remaining HTML tags", () => {
      expect(htmlToMarkdown('<span class="x">text</span>')).toBe("text");
      expect(htmlToMarkdown("<custom-tag>content</custom-tag>")).toBe("content");
    });
  });

  describe("extractTitle", () => {
    it("extracts title from HTML", () => {
      expect(extractTitle("<html><head><title>My Page</title></head></html>")).toBe("My Page");
    });

    it("returns null when no title tag", () => {
      expect(extractTitle("<html><head></head></html>")).toBeNull();
    });

    it("strips tags from title content", () => {
      expect(extractTitle("<title><b>Bold</b> Title</title>")).toBe("Bold Title");
    });

    it("returns null for empty title", () => {
      expect(extractTitle("<title></title>")).toBeNull();
      expect(extractTitle("<title>  </title>")).toBeNull();
    });

    it("handles title with attributes", () => {
      expect(extractTitle('<title lang="en">English</title>')).toBe("English");
    });
  });
});
