import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageMarkdown } from "../src/components/message-markdown";

const render = (content: string) => renderToStaticMarkup(createElement(MessageMarkdown, { content }));

test("Markdown renders readable text structure and GFM content", () => {
  const html = render("## 标题\n\n**强调**和*斜体*、~~删除~~与 `inline()`\n\n- 第一项\n- 第二项\n\n1. 有序项\n\n> 引用内容\n\n```ts\nconst value = '<script>';\n```\n\n| 模型 | 观点 |\n| --- | --- |\n| A | 合作 |");
  for (const expected of ["<h2>标题</h2>", "<strong>强调</strong>", "<em>斜体</em>", "<del>删除</del>", "<code>inline()</code>", "<ul>", "<ol>", "<blockquote>", "<table>", "<th>模型</th>"]) assert.ok(html.includes(expected), expected);
  assert.match(html, /class="message-markdown-table" role="region" aria-label="消息表格" tabindex="0"/);
  assert.match(html, /<pre tabindex="0" aria-label="代码块"><code class="language-ts">/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("raw HTML cannot inject markup, scripts, styles, frames or events", () => {
  const html = render('文本 <img src="https://tracker.invalid/pixel" onerror="alert(1)">\n\n<script>alert(1)</script>\n\n<iframe src="https://evil.invalid"></iframe>\n\n<style>body{display:none}</style>\n\n<div onclick="alert(1)">原始HTML</div>');
  assert.doesNotMatch(html, /<(?:img|script|iframe|style)\b/i);
  assert.doesNotMatch(html, /\b(?:onerror|onclick|src)=/i);
  assert.doesNotMatch(html, /tracker\.invalid|evil\.invalid|display:none/);
});

test("only safe absolute web and mail links are interactive", () => {
  const html = render('[HTTPS](https://example.com/path?q=42) [HTTP](http://example.com) [邮箱](mailto:hello@example.com)');
  assert.match(html, /href="https:\/\/example.com\/path\?q=42"/);
  assert.match(html, /href="http:\/\/example.com\/"/);
  assert.match(html, /href="mailto:hello@example.com"/);
  assert.equal((html.match(/target="_blank" rel="noopener noreferrer"/g) ?? []).length, 3);
});

test("dangerous, disguised and local links retain their text without a clickable URL", () => {
  const unsafe = [
    "javascript:alert%281%29", "JaVaScRiPt:alert%281%29", "javascript&#58;alert%281%29",
    "data:text/html;base64,PHNjcmlwdD4=", "file:///etc/passwd", "vbscript:msgbox%281%29",
    "//example.com/path", "/api/rooms", "#somewhere", "java%09script:alert%281%29", "https:example.com",
  ];
  for (const url of unsafe) {
    const html = render(`[链接文字](${url})`);
    assert.doesNotMatch(html, /<a\b|href=/i, url);
    assert.match(html, /链接文字/);
  }
});

test("Markdown images never create automatic network requests, including linked images", () => {
  const html = render('![说明](https://tracker.invalid/pixel.png) ![数据图片](data:image/png;base64,AAAA) [![缩略图](https://tracker.invalid/thumbnail.png)](https://example.com/image)');
  assert.doesNotMatch(html, /<img\b|<link\b|src=|tracker\.invalid|data:image/i);
  assert.match(html, /\[图片：说明\]/);
  assert.match(html, /\[图片：数据图片\]/);
  assert.match(html, /\[图片：缩略图\]/);
  assert.match(html, /href="https:\/\/example.com\/image"/);
});
