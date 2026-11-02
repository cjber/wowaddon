const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  hellip: "…",
};
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1].toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isSafeInteger(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : whole;
    }
    return entities[name.toLowerCase()] ?? whole;
  });
}
function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\r]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{2,}(?=- )/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
// Store pages come as HTML (CurseForge, WowUp Hub), BBCode (WoWInterface) or Markdown (GitHub,
// Tukui). A terminal shows plain lines, so markup goes and block ends become line breaks.
export function htmlToText(html: string): string {
  return tidy(
    decode(
      html
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
        .replace(/\s+/g, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<li[^>]*>/gi, "\n- ")
        .replace(/<\/(p|div|h[1-6]|li|ul|ol|tr|table|blockquote|pre)>/gi, "\n")
        .replace(/<(p|div|h[1-6]|ul|ol|tr|table|blockquote|pre)(\s[^>]*)?>/gi, "\n")
        .replace(/<[^>]+>/g, ""),
    ),
  );
}
export function bbcodeToText(text: string): string {
  return tidy(
    text
      .replace(/\[\*\]/g, "\n- ")
      .replace(/\[(?:url|img)=[^\]]*\]/gi, "")
      .replace(/\[\/?[a-z]+(?:=[^\]]*)?\]/gi, ""),
  );
}
export function markdownToText(text: string): string {
  return tidy(
    text
      .replace(/^#+\s*/gm, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1"),
  );
}
// Keeps whole lines up to max characters, so a long changelog shows its newest entries.
export function firstLines(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = cut.lastIndexOf("\n");
  return `${(end > max / 2 ? cut.slice(0, end) : cut).trimEnd()}\n…`;
}
