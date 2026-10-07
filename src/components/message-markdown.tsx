import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** Agent output can supply content, never page markup or executable URL schemes. */
function safeLink(url: string): string | undefined {
  if (!/^(?:https?:\/\/|mailto:)/i.test(url) || /[\u0000-\u0020\u007f]/.test(url)) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "mailto:" || parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href;
  } catch { /* An invalid URL is rendered as ordinary text. */ }
  return undefined;
}

const components: Components = {
  a({ href, title, children }) {
    const destination = href ? safeLink(href) : undefined;
    return destination
      ? <a href={destination} title={title} target="_blank" rel="noopener noreferrer">{children}</a>
      : <span>{children}</span>;
  },
  // Images are represented by their description, so model output cannot cause
  // unsolicited requests, tracking pixels, or downloads from external hosts.
  img({ alt }) {
    return <span className="message-markdown-image">[图片{alt ? `：${alt}` : ""}]</span>;
  },
  pre({ children }) {
    return <pre tabIndex={0} aria-label="代码块">{children}</pre>;
  },
  table({ children }) {
    return <div className="message-markdown-table" role="region" aria-label="消息表格" tabIndex={0}><table>{children}</table></div>;
  },
};

/** Import message-markdown.css once from the containing room or layout. */
export const MessageMarkdown = memo(function MessageMarkdown({ content }: { content: string }) {
  return <div className="message-markdown">
    <Markdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={(url, key) => key === "href" ? safeLink(url) : undefined}
      components={components}
    >{content}</Markdown>
  </div>;
});
