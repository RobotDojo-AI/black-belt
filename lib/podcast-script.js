export const DEFAULT_PODCAST_SCRIPT_MODE = 'source';
export const DEFAULT_PODCAST_SCRIPT_AGENT = false;
export const DEFAULT_PODCAST_SCRIPT_AGENT_PROVIDER = 'openai';
export const DEFAULT_PODCAST_SCRIPT_AGENT_MODEL = 'gpt-4o-mini';

const SCRIPT_MODES = new Set(['source', 'podcast']);
const MAX_SCRIPT_INSTRUCTIONS_CHARS = 1600;
const MAX_AGENT_SOURCE_CHARS = 6500;

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitPlainText(text) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];
  const paragraphs = normalized
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return paragraphs.length ? paragraphs : [normalized.replace(/\s+/g, ' ')];
}

function wordCount(text) {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

function toBoolean(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

function cleanArticle(article = {}) {
  const paragraphs = Array.isArray(article.paragraphs) && article.paragraphs.length
    ? article.paragraphs.map((p) => String(p || '').trim()).filter(Boolean)
    : splitPlainText(article.text || '');
  const text = normalizeWhitespace(article.text || paragraphs.join('\n\n'));
  return {
    ...article,
    title: String(article.title || '').trim() || 'Untitled',
    sourceName: String(article.sourceName || '').trim(),
    url: String(article.url || '').trim(),
    paragraphs,
    text,
    wordCount: article.wordCount || wordCount(text),
    charCount: text.length,
  };
}

export function normalizePodcastScriptMode(value) {
  const mode = String(value || DEFAULT_PODCAST_SCRIPT_MODE).trim().toLowerCase();
  return SCRIPT_MODES.has(mode) ? mode : DEFAULT_PODCAST_SCRIPT_MODE;
}

export function normalizePodcastScriptInstructions(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_SCRIPT_INSTRUCTIONS_CHARS);
}

export function normalizePodcastScriptAgent(value) {
  return toBoolean(value);
}

export function normalizePodcastScriptAgentProvider(value) {
  const provider = String(value || DEFAULT_PODCAST_SCRIPT_AGENT_PROVIDER).trim().toLowerCase();
  return provider || DEFAULT_PODCAST_SCRIPT_AGENT_PROVIDER;
}

export function normalizePodcastScriptAgentModel(value) {
  const model = String(value || DEFAULT_PODCAST_SCRIPT_AGENT_MODEL).trim();
  return model || DEFAULT_PODCAST_SCRIPT_AGENT_MODEL;
}

function buildPodcastParagraphs(article) {
  const intro = [
    `Welcome to ${article.title}.`,
    article.sourceName
      ? `This episode follows the source from ${article.sourceName}, preserving the argument while making it easier to listen to.`
      : 'This episode preserves the source argument while making it easier to listen to.',
  ];
  const outro = [`That is ${article.title}.`];
  return [
    ...intro,
    ...article.paragraphs,
    ...outro,
  ].filter(Boolean);
}

export function planPodcastScriptArticle({ article, mode, instructions } = {}) {
  if (!article) throw new Error('article_required');
  const source = cleanArticle(article);
  if (!source.text) throw new Error('article_text_required');

  const cleanMode = normalizePodcastScriptMode(mode);
  const cleanInstructions = normalizePodcastScriptInstructions(instructions);
  if (cleanMode === 'source') {
    return {
      article: source,
      script: {
        mode: cleanMode,
        instructions: cleanInstructions,
        sourceWordCount: source.wordCount,
        renderedWordCount: source.wordCount,
      },
    };
  }

  const paragraphs = buildPodcastParagraphs(source);
  const text = paragraphs.join('\n\n');
  return {
    article: {
      ...source,
      paragraphs,
      text,
      wordCount: wordCount(text),
      charCount: text.length,
    },
    script: {
      mode: cleanMode,
      instructions: cleanInstructions,
      sourceWordCount: source.wordCount,
      renderedWordCount: wordCount(text),
    },
  };
}

function splitParagraphIntoPieces(paragraph, maxChars) {
  const text = String(paragraph || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const pieces = [];
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*|.+$/g) || [text];
  let buffer = '';
  for (const rawSentence of sentences) {
    const sentence = rawSentence.trim();
    if (!sentence) continue;
    if (sentence.length > maxChars) {
      if (buffer) {
        pieces.push(buffer);
        buffer = '';
      }
      for (let i = 0; i < sentence.length; i += maxChars) {
        const chunk = sentence.slice(i, i + maxChars).trim();
        if (chunk) pieces.push(chunk);
      }
      continue;
    }
    const next = buffer ? `${buffer} ${sentence}` : sentence;
    if (next.length > maxChars && buffer) {
      pieces.push(buffer);
      buffer = sentence;
    } else {
      buffer = next;
    }
  }
  if (buffer) pieces.push(buffer);
  return pieces;
}

function splitArticleForAgent(article, maxChars = MAX_AGENT_SOURCE_CHARS) {
  const chunks = [];
  let buffer = '';
  const flush = () => {
    const text = buffer.trim();
    if (text) chunks.push(text);
    buffer = '';
  };

  for (const paragraph of article.paragraphs || []) {
    const pieces = splitParagraphIntoPieces(paragraph, maxChars);
    for (const piece of pieces) {
      const next = buffer ? `${buffer}\n\n${piece}` : piece;
      if (next.length > maxChars && buffer) {
        flush();
        buffer = piece;
      } else {
        buffer = next;
      }
    }
  }
  flush();
  return chunks.length ? chunks : splitParagraphIntoPieces(article.text, maxChars);
}

function cleanGeneratedScriptText(value) {
  return normalizeWhitespace(String(value || '')
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^\s*(?:host|narrator)\s*:\s*/gim, '')
    .trim());
}

function providerText(response) {
  if (!response) return '';
  if (typeof response === 'string') return response;
  if (Array.isArray(response.content)) {
    return response.content.map((part) => part?.text || '').join('');
  }
  return String(response.text || response.content || '');
}

function agentSystemPrompt() {
  return [
    'You are Robot Dojo Podcast, a faithful long-form podcast script editor.',
    'Transform source text into natural solo-host narration for listening.',
    'Preserve the author\'s claims, sequence, names, numbers, and concrete examples.',
    'Do not invent facts, citations, sponsors, ads, music cues, or scene directions.',
    'Do not summarize away key arguments unless the user explicitly asks for a brief version.',
    'Return only narration text. Use short paragraphs separated by blank lines.',
  ].join(' ');
}

function agentUserPrompt({ article, instructions, chunk, index, total }) {
  const custom = instructions
    ? `Listener instructions: ${instructions}`
    : 'Listener instructions: Preserve the core argument and make it easier to follow by ear.';
  return [
    `Title: ${article.title}`,
    article.sourceName ? `Source: ${article.sourceName}` : '',
    custom,
    `Part: ${index + 1} of ${total}`,
    '',
    'Rewrite this source part as podcast narration:',
    chunk,
  ].filter(Boolean).join('\n');
}

async function defaultAgentComplete({ providerName, model, system, messages, signal }) {
  const { getProvider } = await import('./llm/index.js');
  const provider = await getProvider(providerName);
  return provider.complete({
    model,
    system,
    messages,
    max_tokens: 2200,
    signal,
  });
}

export async function planPodcastScriptArticleWithAgent({
  article,
  mode,
  instructions,
  agent = DEFAULT_PODCAST_SCRIPT_AGENT,
  agentProvider = DEFAULT_PODCAST_SCRIPT_AGENT_PROVIDER,
  agentModel = DEFAULT_PODCAST_SCRIPT_AGENT_MODEL,
  agentComplete,
  signal,
} = {}) {
  const cleanMode = normalizePodcastScriptMode(mode);
  const cleanInstructions = normalizePodcastScriptInstructions(instructions);
  const useAgent = cleanMode === 'podcast' && normalizePodcastScriptAgent(agent);
  if (!useAgent) {
    return planPodcastScriptArticle({
      article,
      mode: cleanMode,
      instructions: cleanInstructions,
    });
  }

  const source = cleanArticle(article);
  if (!source.text) throw new Error('article_text_required');

  const cleanProvider = normalizePodcastScriptAgentProvider(agentProvider);
  const cleanModel = normalizePodcastScriptAgentModel(agentModel);
  const sourceChunks = splitArticleForAgent(source);
  const complete = agentComplete || defaultAgentComplete;
  const generated = [];
  const system = agentSystemPrompt();

  for (let index = 0; index < sourceChunks.length; index += 1) {
    const messages = [{
      role: 'user',
      content: agentUserPrompt({
        article: source,
        instructions: cleanInstructions,
        chunk: sourceChunks[index],
        index,
        total: sourceChunks.length,
      }),
    }];
    const response = await complete({
      providerName: cleanProvider,
      model: cleanModel,
      system,
      messages,
      article: source,
      instructions: cleanInstructions,
      chunk: sourceChunks[index],
      index,
      total: sourceChunks.length,
      signal,
    });
    const text = cleanGeneratedScriptText(providerText(response));
    if (!text) throw new Error('script_agent_empty_output');
    generated.push(text);
  }

  const body = generated.join('\n\n');
  const paragraphs = buildPodcastParagraphs({
    ...source,
    paragraphs: splitPlainText(body),
  });
  const text = paragraphs.join('\n\n');
  return {
    article: {
      ...source,
      paragraphs,
      text,
      wordCount: wordCount(text),
      charCount: text.length,
    },
    script: {
      mode: cleanMode,
      instructions: cleanInstructions,
      sourceWordCount: source.wordCount,
      renderedWordCount: wordCount(text),
      agent: {
        enabled: true,
        provider: cleanProvider,
        model: cleanModel,
        sourceChunks: sourceChunks.length,
      },
    },
  };
}
