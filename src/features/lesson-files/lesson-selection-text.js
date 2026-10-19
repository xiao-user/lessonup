import { Marked } from "marked";

// Shared with the editable Markdown parser. Keep this module free of editor,
// DOM and React imports: the Worker uses the same visible-quote contract.
export const lessonHighlightTones = ["yellow", "pink", "green", "blue", "red"];
export const createLessonMarkdownParser = () => new Marked({ breaks: true });

export function tokenizeLessonHighlight(source, inlineTokens) {
  const match = /^==(?:\{(yellow|pink|green|blue|red)\})?([^=\n]+)==/.exec(source);
  if (!match) return undefined;
  const text = match[2].trim();
  if (!text) return undefined;
  return { type: "highlight", raw: match[0], text, tone: match[1] || "yellow", tokens: inlineTokens(text) };
}

const selectionMarkdown = createLessonMarkdownParser();
selectionMarkdown.use({ extensions: [{
  name: "highlight", level: "inline", start: source => source.indexOf("=="),
  tokenizer(source) { return tokenizeLessonHighlight(source, text => this.lexer.inlineTokens(text)); },
}] });

function tokenText(token) {
  if (Array.isArray(token.tokens)) return token.tokens.map(tokenText).join("");
  if (Array.isArray(token.items)) return token.items.map(tokenText).join("\n");
  if (token.type === "table") return [token.header, ...(token.rows ?? [])]
    .flat().filter(Boolean).map(tokenText).join("\n");
  if (token.type === "html") return "";
  // Match the editor's text-token decoder, with ampersands last. Code and
  // escape tokens stay literal; the already-visible quote is never decoded.
  if (token.type === "text") return String(token.text ?? "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  return typeof token.text === "string" ? token.text : "\n";
}

export function lessonSelectionPlainText(source) {
  const visibleSource = String(source ?? "").split("\n")
    .map(line => line === "&nbsp;" || line === "\u2063" ? "" : line).join("\n");
  return selectionMarkdown.lexer(visibleSource).map(tokenText).join("\n");
}

export function getLessonHighlightSpans(source) {
  const spans = [];
  const visit = node => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    if (node.type === "highlight") spans.push({
      text: tokenText(node),
      tone: lessonHighlightTones.includes(node.tone) ? node.tone : "yellow",
    });
    for (const key of ["tokens", "items", "header", "rows"]) {
      if (Array.isArray(node[key])) visit(node[key]);
    }
  };
  visit(selectionMarkdown.lexer(String(source ?? "")));
  return spans;
}

export const normalizeLessonSelectionText = value => String(value ?? "").replace(/\s+/g, "").trim();

export function lessonSelectionMatches(source, quote) {
  const text = normalizeLessonSelectionText(quote);
  return Boolean(text) && normalizeLessonSelectionText(lessonSelectionPlainText(source)).includes(text);
}
