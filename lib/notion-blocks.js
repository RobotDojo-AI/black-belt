/**
 * Markdown → Notion block format converter.
 * Headings (h1-h3), paragraphs, bullet lists, numbered lists, code blocks,
 * horizontal rules. Inline: bold, italic, code, links.
 */

export function markdownInlineToRichText(text) {
  if (!text) return [{ type: 'text', text: { content: ' ' } }];
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '').trim();
  if (!text) return [{ type: 'text', text: { content: ' ' } }];

  const result = [];
  const pattern = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push({ type: 'text', text: { content: text.slice(lastIndex, match.index) } });
    }
    if (match[1]) {
      result.push({ type: 'text', text: { content: match[2] }, annotations: { bold: true } });
    } else if (match[3]) {
      result.push({ type: 'text', text: { content: match[4] }, annotations: { italic: true } });
    } else if (match[5]) {
      result.push({ type: 'text', text: { content: match[6] }, annotations: { code: true } });
    } else if (match[7]) {
      result.push({ type: 'text', text: { content: match[8], link: { url: match[9] } } });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    result.push({ type: 'text', text: { content: text.slice(lastIndex) } });
  }
  if (result.length === 0) result.push({ type: 'text', text: { content: text } });

  const capped = [];
  for (const item of result) {
    const content = item.text?.content || '';
    if (content.length <= 2000) {
      capped.push(item);
    } else {
      for (let c = 0; c < content.length; c += 2000) {
        capped.push({ ...item, text: { ...item.text, content: content.slice(c, c + 2000) } });
      }
    }
  }
  return capped;
}

export function markdownToBlocks(markdown) {
  if (!markdown) return [];
  const lines = markdown.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim() || 'plain text';
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      const content = codeLines.join('\n') || ' ';
      const chunks = [];
      for (let c = 0; c < content.length; c += 2000) {
        chunks.push({ type: 'text', text: { content: content.slice(c, c + 2000) } });
      }
      blocks.push({ object: 'block', type: 'code', code: { rich_text: chunks, language: lang } });
      continue;
    }

    if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
      blocks.push({ object: 'block', type: 'divider', divider: {} });
      i++;
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const t = `heading_${level}`;
      blocks.push({ object: 'block', type: t, [t]: { rich_text: markdownInlineToRichText(headingMatch[2]) } });
      i++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const content = line.replace(/^\s*[-*]\s+/, '');
      blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: markdownInlineToRichText(content) } });
      i++;
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const content = line.replace(/^\s*\d+\.\s+/, '');
      blocks.push({ object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: markdownInlineToRichText(content) } });
      i++;
      continue;
    }

    if (line.trim() === '') { i++; continue; }

    blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: markdownInlineToRichText(line) } });
    i++;
  }

  return blocks;
}
